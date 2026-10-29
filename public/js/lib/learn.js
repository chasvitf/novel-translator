// Learning from the translator's own corrections. Gemini cannot be fine-tuned from an API key, so the
// project keeps what a person changed and every later prompt carries it:
// - examples: source paragraph, what the AI wrote, what the person corrected it to (few-shot)
// - rules: short instructions the AI drew from those corrections
// - glossary: names and technique names the person renamed are locked with the new translation

import { makeEntry, relevantEntries } from "./glossary.js";
import * as P from "./prompts.js";

const MAX_EXAMPLES = 200;
const MAX_RULES = 40;
const LEARN_BATCH = 12; // corrections sent to one learning call
const EXAMPLES_PER_PROMPT = 3;

const paras = (s) => String(s).split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
let seq = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function memoryOf(project) {
  project.memory ||= { examples: [], rules: [] };
  return project.memory;
}

// What the AI wrote for each source paragraph, from the chunks (paragraphs line up only within a chunk).
function aiPairs(chapter) {
  const pairs = [];
  for (const c of chapter.chunks || []) {
    const s = paras(c.src);
    const o = paras(c.out);
    o.forEach((out, i) => pairs.push({ source: s.length === o.length ? s[i] : "", ai: out }));
  }
  return pairs;
}

// Paragraphs the person changed since the AI wrote them (or since the last time we learned from this
// chapter). Needs the same number of paragraphs as the AI version; merged or split paragraphs cannot be
// matched to their source.
export function collectCorrections(chapter) {
  const pairs = aiPairs(chapter);
  const now = paras(chapter.translation);
  if (!pairs.length || pairs.length !== now.length) return { corrections: [], aligned: false };
  const before = chapter.learnedText && paras(chapter.learnedText).length === now.length ? paras(chapter.learnedText) : pairs.map((p) => p.ai);
  const corrections = [];
  now.forEach((fixed, i) => {
    const { source, ai } = pairs[i];
    if (!source || fixed === before[i] || fixed === ai) return;
    corrections.push({ source, ai, fixed });
  });
  return { corrections, aligned: true };
}

// Keep corrections as examples; a newer correction of the same source paragraph replaces the old one.
export function rememberExamples(project, corrections, chapterId) {
  const mem = memoryOf(project);
  for (const c of corrections) {
    mem.examples = mem.examples.filter((e) => e.source !== c.source);
    mem.examples.push({ id: newId("x"), ...c, chapterId, at: Date.now() });
  }
  if (mem.examples.length > MAX_EXAMPLES) mem.examples = mem.examples.slice(-MAX_EXAMPLES);
}

// Character pairs of a text, for a cheap "how alike are these passages" score.
const bigrams = (s) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)).filter((b) => !/\s/.test(b)));

// The corrections most like this passage: sharing glossary terms counts most, then shared wording.
export function relevantExamples(project, chunk, n = EXAMPLES_PER_PROMPT) {
  const ex = project.memory?.examples || [];
  if (!ex.length) return [];
  const terms = relevantEntries(project.glossary || [], chunk).map((e) => e.source);
  const grams = bigrams(chunk);
  return ex
    .map((e) => {
      let shared = 0;
      for (const b of bigrams(e.source)) if (grams.has(b)) shared++;
      const termHits = terms.filter((t) => e.source.includes(t) || e.fixed.includes(t)).length;
      return { e, score: termHits * 5 + shared / Math.max(10, e.source.length) };
    })
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.e);
}

export const ruleTexts = (project) => (project.memory?.rules || []).map((r) => r.text);

// Ask the AI what the corrections teach: renamed terms and general rules. A term is taken only if its
// source is in a corrected paragraph and its new translation is in the correction but not in the AI's
// version (so it really was changed by the person).
export async function learnFromCorrections(project, corrections, call, signal) {
  const mem = memoryOf(project);
  const result = { renamed: [], added: [], rules: [] };
  for (let i = 0; i < corrections.length; i += LEARN_BATCH) {
    const batch = corrections.slice(i, i + LEARN_BATCH);
    const { text } = await call({ system: P.learnSystem(project), user: P.learnUser({ corrections: batch, rules: ruleTexts(project), entries: relevantEntries(project.glossary, batch.map((c) => c.source).join("\n")) }), json: true, signal });
    const data = P.parseJSON(text);
    for (const t of Array.isArray(data.terms) ? data.terms : []) {
      const source = String(t?.source ?? "").trim();
      const target = String(t?.target ?? "").trim();
      if (!source || !target || source.length > 40 || target.length > 60) continue;
      const seen = batch.find((c) => c.source.includes(source) && c.fixed.includes(target) && !c.ai.includes(target));
      if (!seen) continue;
      const old = project.glossary.find((e) => e.source === source);
      if (old) {
        if (old.target === target) continue;
        result.renamed.push({ entry: old, from: old.target, to: target });
        old.target = target;
        old.status = "locked";
      } else {
        const e = makeEntry({ source, target, type: t.type, note: t.note, status: "locked" });
        project.glossary.push(e);
        result.added.push(e);
      }
    }
    const have = new Set(mem.rules.map((r) => r.text));
    for (const r of Array.isArray(data.rules) ? data.rules : []) {
      const text = String(r ?? "").trim();
      if (!text || text.length > 300 || have.has(text)) continue;
      have.add(text);
      const rule = { id: newId("r"), text, at: Date.now() };
      mem.rules.push(rule);
      result.rules.push(rule);
    }
  }
  if (mem.rules.length > MAX_RULES) mem.rules = mem.rules.slice(-MAX_RULES);
  return result;
}
