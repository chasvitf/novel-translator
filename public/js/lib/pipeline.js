// Chapter translation: find new terms → translate chunk by chunk → polish → check glossary → fix.

import { chunkText } from "./split.js";
import { chunkSizeFor } from "./langs.js";
import { relevantEntries, checkTranslation, mergeTerms } from "./glossary.js";
import * as P from "./prompts.js";

const ANALYZE_LIMIT = 20000; // characters of the chapter sent to term extraction
const KNOWN_LIMIT = 200;

export function newChapter(title, text, id) {
  return { id: id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title, text, titleT: "", summary: "", chunks: [], translation: "", status: "new", issues: null, error: "" };
}

export function contextSummary(project, chapter) {
  const i = project.chapters.indexOf(chapter);
  return project.chapters
    .slice(Math.max(0, i - 3), i)
    .filter((c) => c.summary)
    .map((c) => `[${c.titleT || c.title}] ${c.summary}`)
    .join("\n");
}

function previousTail(project, chapter) {
  const i = project.chapters.indexOf(chapter);
  const prev = project.chapters[i - 1];
  return prev?.translation ? tail(prev.translation) : "";
}

const tail = (s, n = 500) => (s.length > n ? "…" + s.slice(-n) : s);

export async function analyzeChapter(project, chapter, call, signal) {
  const text = chapter.text.slice(0, ANALYZE_LIMIT);
  const known = relevantEntries(project.glossary, text).slice(0, KNOWN_LIMIT);
  const { text: reply } = await call({ system: P.analyzeSystem(project), user: P.analyzeUser({ title: chapter.title, text, known }), json: true, signal });
  const data = P.parseJSON(reply);
  // Keep only terms that really occur in the chapter: models sometimes normalize or invent spellings.
  const terms = (Array.isArray(data.terms) ? data.terms : []).filter((t) => t && typeof t.source === "string" && chapter.text.includes(t.source.trim()));
  return { title: String(data.title || "").trim(), summary: String(data.summary || "").trim(), terms };
}

export async function translateChunk(project, src, previous, summary, call, signal, onStep) {
  const entries = relevantEntries(project.glossary, src);
  onStep?.("translate");
  let out = P.cleanReply((await call({ system: P.translateSystem(project), user: P.translateUser({ chunk: src, entries, summary, previous }), signal })).text);
  const draft = out;
  if (project.polish) {
    onStep?.("polish");
    out = P.cleanReply((await call({ system: P.polishSystem(project), user: P.polishUser({ chunk: src, draft: out, entries }), signal })).text);
  }
  let issues = checkTranslation(src, out, entries, project.srcLang, project.tgtLang);
  for (let round = 0; !issues.ok && project.autoFix && round < 2; round++) {
    onStep?.("fix");
    out = P.cleanReply((await call({ system: P.polishSystem(project), user: P.fixUser({ chunk: src, draft: out, entries, issues }), signal })).text);
    issues = checkTranslation(src, out, entries, project.srcLang, project.tgtLang);
  }
  return { src, draft, out, issues };
}

// Translates one chapter in place. `onProgress({step, chunk, total, added})`.
export async function translateChapter(project, chapter, { call, onProgress = () => {}, signal } = {}) {
  chapter.status = "working";
  chapter.error = "";
  try {
    if (project.autoTerms !== "off" || !chapter.summary) {
      onProgress({ step: "analyze" });
      try {
        const a = await analyzeChapter(project, chapter, call, signal);
        chapter.titleT = a.title || chapter.titleT;
        chapter.summary = a.summary || chapter.summary;
        if (project.autoTerms !== "off") {
          const added = mergeTerms(project.glossary, a.terms, project.autoTerms === "auto" ? "locked" : "pending");
          onProgress({ step: "terms", added });
        }
      } catch (e) {
        if (e.name === "AbortError" || e.kind === "auth") throw e;
        onProgress({ step: "warn", message: `ดึงคำศัพท์ไม่สำเร็จ แปลต่อโดยไม่ดึง (${e.message})` });
      }
    }
    const size = Number(project.chunkSize) || chunkSizeFor(project.srcLang);
    const pieces = chunkText(chapter.text, size);
    const summary = contextSummary(project, chapter);
    let previous = previousTail(project, chapter);
    const chunks = [];
    for (let i = 0; i < pieces.length; i++) {
      const c = await translateChunk(project, pieces[i], previous, summary, call, signal, (step) => onProgress({ step, chunk: i, total: pieces.length }));
      chunks.push(c);
      previous = tail(c.out);
    }
    chapter.chunks = chunks;
    chapter.translation = chunks.map((c) => c.out).join("\n\n");
    chapter.issues = mergeIssues(chunks.map((c) => c.issues));
    chapter.status = "done";
    chapter.translatedAt = Date.now();
    onProgress({ step: "done" });
    return chapter;
  } catch (e) {
    chapter.status = e.name === "AbortError" ? (chapter.translation ? "done" : "new") : "error";
    if (e.name !== "AbortError") chapter.error = e.message;
    throw e;
  }
}

function mergeIssues(list) {
  const missing = new Map();
  const leftovers = new Set();
  for (const it of list) {
    for (const m of it.missing) missing.set(m.entry.id, m);
    it.leftovers.forEach((t) => leftovers.add(t));
  }
  return { missing: [...missing.values()], leftovers: [...leftovers], ok: !missing.size && !leftovers.size };
}

// Re-run the glossary check on a whole chapter (after editing the text or the glossary).
export function recheckChapter(project, chapter) {
  if (!chapter.translation) return null;
  chapter.issues = checkTranslation(chapter.text, chapter.translation, project.glossary, project.srcLang, project.tgtLang);
  return chapter.issues;
}

// Fix a finished chapter against the current glossary, chunk by chunk when the chunks are still in sync.
export async function fixChapter(project, chapter, { call, signal, onProgress = () => {} }) {
  const inSync = chapter.chunks?.length && chapter.chunks.map((c) => c.out).join("\n\n") === chapter.translation;
  const pieces = inSync ? chapter.chunks : [{ src: chapter.text, out: chapter.translation }];
  for (let i = 0; i < pieces.length; i++) {
    const c = pieces[i];
    const entries = relevantEntries(project.glossary, c.src);
    const issues = checkTranslation(c.src, c.out, entries, project.srcLang, project.tgtLang);
    if (issues.ok) continue;
    onProgress({ step: "fix", chunk: i, total: pieces.length });
    c.out = P.cleanReply((await call({ system: P.polishSystem(project), user: P.fixUser({ chunk: c.src, draft: c.out, entries, issues }), signal })).text);
    c.issues = checkTranslation(c.src, c.out, entries, project.srcLang, project.tgtLang);
  }
  chapter.translation = pieces.map((c) => c.out).join("\n\n");
  if (inSync) chapter.chunks = pieces;
  return recheckChapter(project, chapter);
}
