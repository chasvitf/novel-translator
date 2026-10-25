// Chapter translation: find new terms → translate chunk by chunk → polish → check glossary → fix.

import { chunkText } from "./split.js";
import { chunkSizeFor } from "./langs.js";
import { relevantEntries, checkTranslation, mergeTerms, issueCount } from "./glossary.js";
import * as P from "./prompts.js";

const ANALYZE_LIMIT = 20000; // characters of the chapter sent to term extraction
const KNOWN_LIMIT = 200;
const ANALYZE_TIMEOUT_MS = 30_000;

function analysisFingerprint(project, chapter) {
  const input = JSON.stringify([
    chapter.text,
    project.srcLang,
    project.tgtLang,
    project.nameStyle,
    project.glossary.map((e) => [e.source, e.target, e.type, e.note]),
  ]);
  // Small deterministic fingerprint; the source text itself stays in the chapter only once.
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${input.length}:${(hash >>> 0).toString(36)}`;
}

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

export async function analyzeChapter(project, chapter, call, signal, onStart) {
  const text = chapter.text.slice(0, ANALYZE_LIMIT);
  const known = relevantEntries(project.glossary, text).slice(0, KNOWN_LIMIT);
  const { text: reply } = await call({ system: P.analyzeSystem(project), user: P.analyzeUser({ title: chapter.title, text, known }), json: true, signal, onStart });
  const data = P.parseJSON(reply);
  // Keep only terms that really occur in the chapter: models sometimes normalize or invent spellings.
  const terms = (Array.isArray(data.terms) ? data.terms : []).filter((t) => t && typeof t.source === "string" && chapter.text.includes(t.source.trim()));
  return { title: String(data.title || "").trim(), summary: String(data.summary || "").trim(), terms };
}

async function analyzeChapterWithTimeout(project, chapter, call, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromRun = () => controller.abort();
  signal?.addEventListener("abort", abortFromRun, { once: true });
  if (signal?.aborted) controller.abort();
  // The clock starts when the request is sent: on Pollinations the wait for a turn alone is 31 seconds.
  let timer;
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ANALYZE_TIMEOUT_MS);
  };
  try {
    return await analyzeChapter(project, chapter, call, controller.signal, start);
  } catch (e) {
    if (timedOut && !signal?.aborted) {
      const timeoutError = new Error("AI หาคำใหม่ไม่ตอบภายใน 30 วินาที");
      timeoutError.kind = "analysis-timeout";
      throw timeoutError;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromRun);
  }
}

// A reply cut off for length means the chunk was too big for this model, and a safety refusal from
// every model usually comes from the passage as a whole: in both cases halve it and go again.
export async function translateChunk(project, src, previous, summary, call, signal, onStep, reviewCall = call) {
  try {
    return await translateOne(project, src, previous, summary, call, signal, onStep, reviewCall);
  } catch (e) {
    if (!(e.kind === "length" || e.kind === "blocked") || src.length < 300) throw e;
    const halves = chunkText(src, Math.ceil(src.length / 2));
    if (halves.length < 2) throw e;
    const parts = [];
    for (const h of halves) {
      parts.push(await translateChunk(project, h, previous, summary, call, signal, onStep, reviewCall));
      previous = tail(parts.at(-1).out);
    }
    const join = (k) => parts.map((x) => x[k]).join("\n\n");
    const issues = mergeIssues(parts.map((x) => x.issues));
    const review = parts.some((x) => x.review) ? mergeReviews(parts.map((x) => x.review)) : undefined;
    return { src, draft: join("draft"), out: join("out"), issues, model: parts[0].model, ...(review ? { review } : {}) };
  }
}

async function translateOne(project, src, previous, summary, call, signal, onStep, reviewCall) {
  const entries = relevantEntries(project.glossary, src);
  onStep?.("translate");
  const first = await call({ system: P.translateSystem(project), user: P.translateUser({ chunk: src, entries, summary, previous }), signal });
  let out = P.cleanReply(first.text);
  // A reply a fifth the length of its source is a refusal or a cut-off answer, not a translation (real
  // Pollinations answered a 7,000-character chapter with "ขออภัย ฉันไม่สามารถ…"). As "blocked" it gets
  // split in half and tried again, and if it never works the chapter ends as an error, not as done.
  if (src.length >= 40 && out.length < src.length * 0.2)
    throw Object.assign(new Error(`AI ไม่ได้แปลท่อนนี้ (ตอบว่า “${out.slice(0, 60)}”)`), { kind: "blocked" });
  const draft = out;
  if (project.polish) {
    onStep?.("polish");
    out = P.cleanReply((await call({ system: P.polishSystem(project), user: P.polishUser({ chunk: src, draft: out, entries }), signal })).text);
  }
  let issues = checkTranslation(src, out, entries, project.srcLang, project.tgtLang);
  // Up to 3 fix rounds while each one still helps (a list of ten names can take more than one).
  for (let round = 0; score(issues) && project.autoFix && round < 3; round++) {
    onStep?.("fix", issues);
    let fixed;
    try {
      fixed = P.cleanReply((await call({ system: P.polishSystem(project), user: P.fixUser({ chunk: src, draft: out, entries, issues }), signal })).text);
    } catch (e) {
      // A refused or failed fix keeps the translation we already have; the issues stay listed for the user.
      if (e.kind === "blocked" || e.kind === "bad" || e.kind === "length") break;
      throw e;
    }
    const after = checkTranslation(src, fixed, entries, project.srcLang, project.tgtLang);
    if (!acceptFix(out, fixed, issues, after)) break;
    out = fixed;
    issues = after;
  }
  if (project.autoFix && issues.leftovers.length) ({ out, issues } = await patchLeftovers(project, src, out, entries, call, signal));
  if (project.autoFix && issues.structure.length) ({ out, issues } = await repairStructure(project, src, out, entries, summary, previous, call, signal, onStep));
  let review;
  if (project.review) ({ out, issues, review } = await reviewChunk(project, src, out, entries, summary, reviewCall, call, signal, onStep));
  return { src, draft, out, issues, model: first.model, ...(review ? { review } : {}) };
}

const paras = (s) => String(s).split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
const oneParagraph = (s) => P.cleanReply(s).replace(/\s*\n\s*/g, " ");
const maxCorrections = (project) => project.maxCorrections ?? 3;

// Share of the old text's character pairs still present in the new text.
function overlap(before, after) {
  const pairs = (s) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const a = pairs(before);
  const b = pairs(after);
  let kept = 0;
  for (const x of a) if (b.has(x)) kept++;
  return kept / Math.max(1, a.size);
}

// Missing or broken paragraphs found by the structure check. A chunk that lost paragraphs is translated
// once more; a single short or quote-less paragraph is translated again on its own. A new version is kept
// only if it removes structure problems without adding name or script problems.
async function repairStructure(project, src, out, entries, summary, previous, call, signal, onStep) {
  let issues = checkTranslation(src, out, entries, project.srcLang, project.tgtLang);
  const keep = (next) => {
    const after = checkTranslation(src, next, entries, project.srcLang, project.tgtLang);
    if (after.structure.length >= issues.structure.length || score(after) > score(issues)) return false;
    if (after.leftovers.some((t) => !issues.leftovers.includes(t))) return false;
    out = next;
    issues = after;
    return true;
  };
  const translate = async (chunk, prev) => {
    onStep?.("repair", issues);
    try {
      return (await call({ system: P.translateSystem(project), user: P.translateUser({ chunk, entries: relevantEntries(entries, chunk), summary, previous: prev }), signal })).text;
    } catch (e) {
      if (e.kind === "blocked" || e.kind === "bad" || e.kind === "length") return null;
      throw e;
    }
  };
  if (issues.structure.some((s) => s.kind === "paragraphs")) {
    const again = await translate(src, previous);
    if (again != null) keep(P.cleanReply(again));
  }
  for (let n = 0; n < maxCorrections(project) && issues.structure.length; n++) {
    const s = issues.structure.find((x) => x.para != null);
    if (!s) break;
    const srcPs = paras(src);
    const outPs = paras(out);
    const again = await translate(srcPs[s.para], outPs[s.para - 1] ?? previous);
    if (again == null) break;
    outPs[s.para] = oneParagraph(again);
    if (!keep(outPs.join("\n\n"))) break;
  }
  return { out, issues };
}

// Independent review: a separate request (on another model when the app has one) compares source and
// translation paragraph by paragraph and must quote both sides. Findings whose quotes are not in the text
// are dropped. Real ones get a correction of that paragraph only, which is reviewed again; what is still
// wrong, or beyond the per-chunk budget, is kept for a human to check.
const REVIEW_TYPES = new Set(["omission", "addition", "meaning", "name", "pronoun", "dialogue", "context"]);

function validFindings(data, srcPs, outPs, src) {
  return (Array.isArray(data?.issues) ? data.issues : []).filter((f) => {
    if (!f || typeof f !== "object" || !REVIEW_TYPES.has(f.type) || !String(f.problem || "").trim()) return false;
    const n = Number(f.paragraph);
    if (!Number.isInteger(n) || n < 1 || n > outPs.length) return false;
    const s = String(f.source || "").trim();
    const t = String(f.translation || "").trim();
    // An omission has nothing to quote on the translation side.
    return s && src.includes(s) && (f.type === "omission" || (t && outPs[n - 1].includes(t)));
  }).map((f) => ({ paragraph: Number(f.paragraph), type: f.type, source: String(f.source).trim(), translation: String(f.translation || "").trim(), problem: String(f.problem).trim() }));
}

async function reviewChunk(project, src, out, entries, summary, reviewCall, call, signal, onStep) {
  const srcPs = paras(src);
  let outPs = paras(out);
  const review = { model: "", found: [], fixed: [], unresolved: [] };
  const ask = async (s, o) => {
    const r = await reviewCall({ system: P.reviewSystem(project), user: P.reviewUser({ src: s, out: o, entries: relevantEntries(entries, s.join("\n")), summary }), json: true, signal });
    review.model ||= r.model || "";
    return validFindings(P.parseJSON(r.text), s, o, s.join("\n"));
  };
  try {
    onStep?.("review");
    review.found = await ask(srcPs, outPs);
  } catch (e) {
    if (e.name === "AbortError" || e.kind === "auth") throw e;
    review.error = e.message;
    return { out, issues: checkTranslation(src, out, entries, project.srcLang, project.tgtLang), review };
  }
  // At most `maxCorrections` paragraphs per chunk get one correction each, and all corrections are checked
  // again in one request, so a chunk costs at most maxCorrections + 2 review-related calls.
  // Models often split a source paragraph (verse especially), so the source to correct against is the
  // paragraph holding the reviewer's quote. Missing text cannot be placed safely without aligned paragraphs.
  const aligned = srcPs.length === outPs.length;
  const tried = [];
  let attempts = 0;
  for (const n of [...new Set(review.found.map((f) => f.paragraph))]) {
    const problems = review.found.filter((f) => f.paragraph === n);
    if (attempts >= maxCorrections(project) || (!aligned && problems.some((f) => f.type === "omission"))) {
      review.unresolved.push(...problems);
      continue;
    }
    const i = n - 1;
    // A quote found in several source paragraphs (a repeated name) cannot say which one to correct against.
    const holders = aligned ? [srcPs[i]] : [...new Set(problems.map((f) => { const at = srcPs.filter((p) => p.includes(f.source)); return at.length === 1 ? at[0] : undefined; }))];
    if (holders.includes(undefined)) {
      review.unresolved.push(...problems);
      continue;
    }
    attempts++;
    const source = holders.join("\n\n");
    const termsHere = relevantEntries(entries, source);
    onStep?.("correct");
    let fixed;
    try {
      fixed = oneParagraph((await call({ system: P.polishSystem(project), user: P.correctUser({ source, translation: outPs[i], problems, entries: termsHere }), signal })).text);
    } catch (e) {
      if (!(e.kind === "blocked" || e.kind === "bad" || e.kind === "length")) throw e;
    }
    const before = checkTranslation(source, outPs[i], termsHere, project.srcLang, project.tgtLang);
    const ratio = (fixed?.length || 0) / Math.max(1, outPs[i].length);
    // A correction is an edit: it must keep most of the paragraph (a real model once returned a translation
    // of a different passage) and change something. Measured on real Thai output: unrelated paragraphs
    // overlap 0.25 (median) to 0.64 (99th percentile); replacing a quarter of a paragraph keeps 0.69 or more.
    const edit = fixed && fixed !== outPs[i] && overlap(outPs[i], fixed) >= 0.65;
    if (!edit || score(checkTranslation(source, fixed, termsHere, project.srcLang, project.tgtLang)) > score(before) || ratio < 0.5 || ratio > 2) review.unresolved.push(...problems);
    else tried.push({ n, problems, source, fixed });
  }
  if (tried.length) {
    let again = null;
    try {
      const r = await reviewCall({ system: P.verifySystem(project), user: P.verifyUser(tried.map((t) => ({ ...t, before: outPs[t.n - 1] }))), json: true, signal });
      again = validFindings(P.parseJSON(r.text), tried.map((t) => t.source), tried.map((t) => t.fixed), tried.map((t) => t.source).join("\n\n"));
    } catch (e) {
      if (e.name === "AbortError" || e.kind === "auth") throw e;
    }
    tried.forEach((t, k) => {
      const still = again?.filter((f) => f.paragraph === k + 1);
      if (still && !still.length) {
        review.fixed.push({ paragraph: t.n, problems: t.problems, before: outPs[t.n - 1], after: t.fixed });
        outPs = outPs.map((p, j) => (j === t.n - 1 ? t.fixed : p));
      } else review.unresolved.push(...(still?.length ? still.map((f) => ({ ...f, paragraph: t.n })) : t.problems));
    });
  }
  if (review.fixed.length) out = outPs.join("\n\n");
  return { out, issues: checkTranslation(src, out, entries, project.srcLang, project.tgtLang), review };
}

function mergeReviews(list) {
  const r = list.filter(Boolean);
  const all = (k) => r.flatMap((x) => x[k] || []);
  return { model: [...new Set(r.map((x) => x.model).filter(Boolean))].join(", "), found: all("found"), fixed: all("fixed"), unresolved: all("unresolved"), ...(r.find((x) => x.error) ? { error: r.find((x) => x.error).error } : {}) };
}

// Translates one chapter in place. `onProgress({step, chunk, total, added})`.
const score = (issues) => issues.missing.length + issues.leftovers.length;

// Take a "fixed" version only if it has fewer problems and is still the same text. A small model once
// answered a fix request by pasting the Chinese source back into the Thai translation.
export function acceptFix(before, after, issuesBefore, issuesAfter) {
  if (score(issuesAfter) >= score(issuesBefore)) return false;
  if ((issuesAfter.structure?.length || 0) > (issuesBefore.structure?.length || 0)) return false; // dropped or merged paragraphs
  if (issuesAfter.leftovers.some((t) => !issuesBefore.leftovers.includes(t))) return false; // new garbage
  const ratio = after.length / Math.max(1, before.length);
  return ratio > 0.8 && ratio < 1.25;
}

// Fix stray foreign script that a whole-chunk fix left in place, using only the words around it.
const PATCH_SPAN = 60;
export async function patchLeftovers(project, src, out, entries, call, signal) {
  let issues = checkTranslation(src, out, entries, project.srcLang, project.tgtLang);
  for (const bad of issues.leftovers.slice(0, 5)) {
    const at = out.indexOf(bad);
    if (at < 0) continue;
    // Widen to whole words: back and forward to the nearest whitespace past PATCH_SPAN characters.
    let a = Math.max(0, at - PATCH_SPAN), b = Math.min(out.length, at + bad.length + PATCH_SPAN);
    while (a > 0 && !/\s/.test(out[a - 1]) && at - a < PATCH_SPAN * 2) a--;
    while (b < out.length && !/\s/.test(out[b]) && b - at < PATCH_SPAN * 3) b++;
    const snippet = out.slice(a, b);
    let fixed;
    try {
      fixed = P.cleanReply((await call({ system: P.polishSystem(project), user: P.patchUser({ snippet, bad, tgtLang: project.tgtLang }), signal })).text);
    } catch (e) {
      if (e.kind === "blocked" || e.kind === "bad" || e.kind === "length") continue;
      throw e;
    }
    const next = out.slice(0, a) + fixed + out.slice(b);
    const after = checkTranslation(src, next, entries, project.srcLang, project.tgtLang);
    const ratio = fixed.length / Math.max(1, snippet.length);
    if (!after.leftovers.includes(bad) && score(after) < score(issues) && after.structure.length <= issues.structure.length && !after.leftovers.some((t) => !issues.leftovers.includes(t)) && ratio > 0.7 && ratio < 1.4) {
      out = next;
      issues = after;
    }
  }
  return { out, issues };
}

// Calls, tokens and time a chapter took; failed calls are not counted.
function counted(fn, stats) {
  return async (req) => {
    const r = await fn(req);
    stats.calls++;
    stats.tokens += r.usage || 0;
    return r;
  };
}

export async function translateChapter(project, chapter, { call, reviewCall = call, onProgress = () => {}, signal } = {}) {
  chapter.status = "working";
  chapter.error = "";
  const stats = { calls: 0, tokens: 0, ms: 0 };
  const started = Date.now();
  call = counted(call, stats);
  reviewCall = counted(reviewCall, stats);
  try {
    // Term discovery and summaries cost a separate API call. Reuse the result while its source,
    // languages, name style, and glossary are unchanged. Turning term discovery off skips it.
    const analyzeKey = analysisFingerprint(project, chapter);
    if (project.autoTerms !== "off" && chapter.analysisKey !== analyzeKey) {
      onProgress({ step: "analyze" });
      try {
        const a = await analyzeChapterWithTimeout(project, chapter, call, signal);
        chapter.titleT = a.title || chapter.titleT;
        chapter.summary = a.summary || chapter.summary;
        const added = mergeTerms(project.glossary, a.terms, project.autoTerms === "auto" ? "locked" : "pending", project.tgtLang);
        onProgress({ step: "terms", added });
        // Merging terms changes the glossary, so fingerprint the final analyzed state.
        chapter.analysisKey = analysisFingerprint(project, chapter);
      } catch (e) {
        if (signal?.aborted || e.kind === "auth") throw e;
        const detail = e.kind === "analysis-timeout"
          ? "ข้ามการหาคำใหม่แล้วแปลต่อ (ตั้งค่าเป็น ‘ไม่ต้องหา’ เพื่อลดเวลาทุกตอน)"
          : `แปลต่อโดยไม่ดึง (${e.message})`;
        onProgress({ step: "warn", message: `ดึงคำศัพท์ไม่สำเร็จ ${detail}` });
      }
    }
    const size = Number(project.chunkSize) || chunkSizeFor(project.srcLang);
    const pieces = chunkText(chapter.text, size);
    const summary = contextSummary(project, chapter);
    let previous = previousTail(project, chapter);
    const chunks = [];
    for (let i = 0; i < pieces.length; i++) {
      const c = await translateChunk(project, pieces[i], previous, summary, call, signal, (step, issues) => onProgress({ step, chunk: i, total: pieces.length, issues }), reviewCall);
      chunks.push(c);
      previous = tail(c.out);
    }
    chapter.chunks = chunks;
    chapter.translation = chunks.map((c) => c.out).join("\n\n");
    chapter.issues = mergeIssues(chunks.map((c) => c.issues));
    chapter.models = [...new Set(chunks.map((c) => c.model).filter(Boolean))];
    if (project.review) chapter.review = mergeReviews(chunks.map((c) => c.review));
    else delete chapter.review;
    chapter.stats = { ...stats, ms: Date.now() - started };
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
  const structure = [];
  for (const it of list) {
    for (const m of it.missing) missing.set(m.entry.id, m);
    it.leftovers.forEach((t) => leftovers.add(t));
    structure.push(...(it.structure || []));
  }
  return { missing: [...missing.values()], leftovers: [...leftovers], structure, ok: !missing.size && !leftovers.size && !structure.length };
}

// Re-run the glossary check on a whole chapter (after editing the text or the glossary).
// Chunk by chunk while the chunks still make up the translation (not edited by hand since): paragraphs
// line up only within a chunk, and comparing them across the whole chapter flagged the wrong ones.
const chunksInSync = (chapter) => chapter.chunks?.length > 0 && chapter.chunks.map((c) => c.out).join("\n\n") === chapter.translation;

export function recheckChapter(project, chapter) {
  if (!chapter.translation) return null;
  const check = (src, out) => checkTranslation(src, out, project.glossary, project.srcLang, project.tgtLang);
  chapter.issues = chunksInSync(chapter) ? mergeIssues(chapter.chunks.map((c) => (c.issues = check(c.src, c.out)))) : check(chapter.text, chapter.translation);
  return chapter.issues;
}

// Fix a finished chapter against the current glossary, chunk by chunk when the chunks are still in sync.
export async function fixChapter(project, chapter, { call, signal, onProgress = () => {} }) {
  chapter.status = "working";
  chapter.error = "";
  try {
    const inSync = chunksInSync(chapter);
    const pieces = inSync ? chapter.chunks : [{ src: chapter.text, out: chapter.translation }];
    for (let i = 0; i < pieces.length; i++) {
      const c = pieces[i];
      const entries = relevantEntries(project.glossary, c.src);
      // Two tries per chunk: a rejected attempt (worse, or new garbage) often succeeds the second time.
      for (let attempt = 0; attempt < 2; attempt++) {
        const issues = checkTranslation(c.src, c.out, entries, project.srcLang, project.tgtLang);
        if (!score(issues)) break;
        onProgress({ step: "fix", chunk: i, total: pieces.length, issues });
        let fixed;
        try {
          fixed = P.cleanReply((await call({ system: P.polishSystem(project), user: P.fixUser({ chunk: c.src, draft: c.out, entries, issues }), signal })).text);
        } catch (e) {
          if (e.kind === "blocked" || e.kind === "bad" || e.kind === "length") break;
          throw e;
        }
        const after = checkTranslation(c.src, fixed, entries, project.srcLang, project.tgtLang);
        if (acceptFix(c.out, fixed, issues, after)) {
          c.out = fixed;
          c.issues = after;
        }
      }
      const left = checkTranslation(c.src, c.out, entries, project.srcLang, project.tgtLang);
      if (left.leftovers.length) {
        onProgress({ step: "fix", chunk: i, total: pieces.length, issues: left });
        ({ out: c.out, issues: c.issues } = await patchLeftovers(project, c.src, c.out, entries, call, signal));
      }
      if (checkTranslation(c.src, c.out, entries, project.srcLang, project.tgtLang).structure.length)
        ({ out: c.out, issues: c.issues } = await repairStructure(project, c.src, c.out, entries, contextSummary(project, chapter), "", call, signal, (step) => onProgress({ step, chunk: i, total: pieces.length })));
    }
    chapter.translation = pieces.map((c) => c.out).join("\n\n");
    if (inSync) chapter.chunks = pieces;
    const issues = recheckChapter(project, chapter);
    chapter.status = "done";
    chapter.translatedAt = Date.now();
    return issues;
  } catch (e) {
    chapter.status = e.name === "AbortError" ? (chapter.translation ? "done" : "new") : (chapter.translation ? "done" : "error");
    if (e.name !== "AbortError") chapter.error = e.message;
    throw e;
  }
}

// A tab closed or crashed mid-run leaves chapters marked "working"; nothing is translating them any more.
export function resetStuck(project) {
  for (const c of project.chapters) if (c.status === "working") c.status = c.translation ? "done" : "new";
}

// Translate a list of chapters with `lanes` workers. Workers take chapters in order, so finished chapters
// appear one after another and can be read while the rest translate; the glossary is shared, so terms
// found in one chapter apply to the next. Each finished or failed chapter goes to `onChapter` (to save it)
// right away. A failed chapter does not stop the others; running out of quota, a bad key or a stop does.
export async function runChapters(project, queue, { call, reviewCall = call, lanes = 1, signal, onStart, onProgress, onChapter } = {}) {
  let next = 0;
  let stopped = null;
  let done = 0;
  let failed = 0;
  let downInARow = 0; // chapters failed in a row on network or rate errors: the service is down
  async function worker() {
    while (!stopped && next < queue.length) {
      const ch = queue[next++];
      let error = null;
      onStart?.(ch);
      try {
        await translateChapter(project, ch, { call, reviewCall, signal, onProgress: (e) => onProgress?.(ch, e) });
        done++;
        downInARow = 0;
      } catch (e) {
        error = e;
        if (e.name === "AbortError") stopped = "cancelled";
        else {
          failed++;
          if (e.kind === "auth" || e.kind === "quota") stopped ||= e.kind;
          // Each such chapter already spent its retries; without this, a dead service fails every chapter left.
          if ((e.kind === "network" || e.kind === "rate") && ++downInARow >= 3) stopped ||= "failing";
        }
      }
      try {
        await onChapter?.(ch, error);
      } catch {
        // The translation stays in memory and goes out with the next save; one failed save must not stop the run.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, queue.length)) }, worker));
  return { done, failed, stopped };
}
