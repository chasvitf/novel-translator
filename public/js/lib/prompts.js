// Prompt builders. Instructions are in English (models follow them most reliably);
// the output language comes from the project settings.

import { langByCode, genreById, NAME_STYLES, LANG_NOTES } from "./langs.js";
import { typeName } from "./glossary.js";

const L = (code) => langByCode(code).en;

export function nameRule(settings) {
  const styles = NAME_STYLES[settings.srcLang];
  const s = styles && (styles.find((x) => x.id === settings.nameStyle) || styles[0]);
  return s ? s.rule : "Transliterate names into the target language the way published translations usually do.";
}

function quoteRule(tgt) {
  if (tgt === "th") return "Use Thai punctuation for dialogue: “ ” for speech and ‘ ’ inside it; turn 「」『』 and other quote marks into these.";
  if (tgt === "ja" || tgt === "zh") return "Use 「」 for speech.";
  return "Use the dialogue punctuation that is standard for published novels in the target language.";
}

export function glossaryBlock(entries) {
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.source} → ${e.target} (${typeName(e.type)}${e.note ? `; ${e.note}` : ""})`);
  return `GLOSSARY (locked; use these exact translations whenever the source term appears):\n${lines.join("\n")}`;
}

export function translateSystem(s) {
  const tgt = L(s.tgtLang);
  return [
    `You are an experienced literary translator of web novels from ${L(s.srcLang)} into ${tgt}.`,
    `Translate the passage the user gives into fluent, natural ${tgt} that reads like a professionally published novel, not like a machine translation.`,
    "",
    "Rules:",
    "1. Translate every sentence. Do not summarize, skip, merge away or add content. Write exactly one translated paragraph for each source paragraph, in the same order, separated by one blank line.",
    "2. When a term from the GLOSSARY appears in the passage, write its locked translation exactly as given, character for character. Never write a glossary translation for something that is not in the passage.",
    `3. Names and terms not in the glossary: ${nameRule(s)} Prefer a well-known ${tgt} rendering when one exists; translate meaningful epithets and titles by meaning. Keep each one the same everywhere in the passage.`,
    `4. Style: ${genreById(s.genre).style}`,
    `5. ${quoteRule(s.tgtLang)}`,
    "6. Keep pronouns, forms of address and politeness levels consistent with the story context and the notes in the glossary. Where the source leaves something open (who is speaking, a pronoun, a vague phrase), keep it open rather than inventing an explanation.",
    "7. Output only the translated passage: no title, no notes, no explanations, no source text.",
    LANG_NOTES[s.srcLang] ? `8. ${LANG_NOTES[s.srcLang]}` : "",
    s.custom ? `\nExtra instructions from the translator:\n${s.custom}` : "",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export function translateUser({ chunk, entries, summary, previous }) {
  const parts = [];
  if (summary) parts.push(`STORY SO FAR (context only, do not translate):\n${summary}`);
  const g = glossaryBlock(entries);
  if (g) parts.push(g);
  if (previous) parts.push(`END OF THE PREVIOUS PASSAGE, ALREADY TRANSLATED (for continuity only, do not repeat it):\n${previous}`);
  parts.push(`PASSAGE TO TRANSLATE:\n<<<\n${chunk}\n>>>`);
  return parts.join("\n\n");
}

export function polishSystem(s) {
  const tgt = L(s.tgtLang);
  return [
    `You are a senior ${tgt} fiction editor who also reads ${L(s.srcLang)}.`,
    `You receive a source passage and a draft ${tgt} translation. Return an improved version of the draft.`,
    "",
    "Do:",
    "- Fix mistranslations and restore anything the draft left out, by comparing with the source.",
    `- Make the prose smooth and natural for ${tgt} readers: idiomatic word order, varied sentence rhythm, no translationese.`,
    `- Style: ${genreById(s.genre).style}`,
    "- Keep every GLOSSARY translation exactly as written.",
    "- Keep the same paragraphs in the same order, separated by one blank line.",
    "Do not add events, explanations or commentary. Output only the revised passage.",
    s.custom ? `\nExtra instructions from the translator:\n${s.custom}` : "",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export function polishUser({ chunk, draft, entries }) {
  return [glossaryBlock(entries), `SOURCE:\n<<<\n${chunk}\n>>>`, `DRAFT TRANSLATION:\n<<<\n${draft}\n>>>`].filter(Boolean).join("\n\n");
}

export function fixUser({ chunk, draft, entries, issues }) {
  const lines = [];
  for (const m of issues.missing) {
    lines.push(`- The source term "${m.entry.source}" must be translated as "${m.entry.target}" (it appears ${m.expected} time(s) in the source). Replace whatever the draft wrote for it.`);
  }
  for (const t of issues.leftovers) lines.push(`- "${t}" is foreign text left in the translation. Replace it with the natural target-language word for what the source means there (translate by meaning; transliterate only names). If it is a stray fragment, remove it.`);
  return [
    "The draft below breaks these requirements. Correct only what is needed to meet them and keep the rest of the draft as it is:",
    lines.join("\n"),
    glossaryBlock(entries),
    `SOURCE:\n<<<\n${chunk}\n>>>`,
    `DRAFT TRANSLATION:\n<<<\n${draft}\n>>>`,
    "Output only the corrected passage.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function analyzeSystem(s) {
  const tgt = L(s.tgtLang);
  return [
    `You prepare ${L(s.srcLang)} novel chapters for translation into ${tgt}.`,
    "Return JSON only, with this shape:",
    `{"title": "<the chapter title translated into ${tgt}, or empty>", "terms": [{"source": "<exact text as it appears in the chapter>", "target": "<${tgt} translation>", "type": "person|place|skill|org|item|title|other", "note": "<short ${tgt} note: gender, role, relationships, how others address them>"}], "summary": "<${tgt} summary of this chapter in at most 120 words: who appears, where, what happens, how the main characters address each other>"}`,
    "",
    "List at most 40 terms, the most important first.",
    "Terms to list: names of people (also nicknames and titles used as names), places, sects/clans/organizations, martial arts and cultivation techniques, cultivation ranks, magic items and weapons, and other invented terms that must stay consistent across chapters.",
    "Do not list ordinary words. Do not list terms that are already in the KNOWN TERMS list. Use the exact source spelling found in the chapter.",
    `Give exactly one ${tgt} translation per term, written fully in ${tgt} script (no alternatives separated by \"/\", no source characters left inside).`,
    "List each name on its own: split a chain such as 東京開封府汴梁宣武軍 into its separate place names, and list a person apart from the title in front of them unless the title is part of how they are always called.",
    `For the translation of names: ${nameRule(s)}`,
    `If a name, place or title already has a well-known ${tgt} rendering (from classic published translations or common use), use that rendering.`,
    "Epithets, titles and nicknames that carry a meaning (for example 美猴王 \"Handsome Monkey King\", 齊天大聖 \"Great Sage Equal to Heaven\") are translated by meaning, not transliterated. Technique and item names are translated by meaning unless the genre convention is to transliterate them.",
  ].join("\n");
}

export function analyzeUser({ title, text, known }) {
  const k = known.length ? `KNOWN TERMS (already in the glossary, do not list them):\n${known.map((e) => `${e.source} → ${e.target}`).join("\n")}` : "";
  return [k, `CHAPTER TITLE: ${title || "(none)"}`, `CHAPTER:\n<<<\n${text}\n>>>`].filter(Boolean).join("\n\n");
}

// Independent review: paragraphs are numbered on both sides so every finding points at one paragraph,
// and the reviewer must quote the source and the translation so a finding can be verified in code.
const numbered = (list) => list.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");

export function reviewSystem(s) {
  const tgt = L(s.tgtLang);
  return [
    `You check ${tgt} translations of ${L(s.srcLang)} novel passages for errors of content. You did not write the translation.`,
    "Compare each numbered source paragraph with the translated paragraph of the same number and report only real errors:",
    "- omission: information in the source that the translation leaves out",
    "- addition: information in the translation that the source does not support",
    "- meaning: a sentence or phrase translated with a different meaning (wrong tense, negation, number, who did what)",
    "- name: a name or term that does not match the GLOSSARY or changes between paragraphs",
    "- pronoun: a wrong pronoun, gender, form of address or relationship between characters",
    "- dialogue: speech given to the wrong speaker, or speech and narration mixed up",
    "- context: a contradiction with the STORY SO FAR",
    "Do not report style preferences or wording you would merely phrase differently. If the source is ambiguous and the translation keeps it ambiguous, that is not an error.",
    'Return JSON only: {"issues": [{"paragraph": <number>, "type": "<one of the types above>", "source": "<exact words copied from the source paragraph>", "translation": "<exact words copied from the translated paragraph; empty for an omission>", "problem": "<one sentence in English: what is wrong>"}]}',
    'Copy the quotes character for character. If there are no errors, return {"issues": []}.',
  ].join("\n");
}

export function reviewUser({ src, out, entries, summary }) {
  return [
    summary ? `STORY SO FAR (context only):\n${summary}` : "",
    glossaryBlock(entries),
    `SOURCE PARAGRAPHS:\n${numbered(src)}`,
    `TRANSLATED PARAGRAPHS:\n${numbered(out)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Re-check of corrected paragraphs: only whether the listed problems are gone. A whole review here would
// report the rest of a split source paragraph as missing.
export function verifySystem(s) {
  return [
    `You check whether corrections to a ${L(s.tgtLang)} translation of a ${L(s.srcLang)} novel fixed the listed problems.`,
    "For each numbered item you get the source, the old translation, the problems found in it and the new translation.",
    "Report a problem only if the NEW translation still has it, or if the correction introduced a new error in what it changed. Ignore everything else, including source text that the translated paragraph does not cover.",
    'Return JSON only: {"issues": [{"paragraph": <item number>, "type": "omission|addition|meaning|name|pronoun|dialogue|context", "source": "<exact words from that item\'s source>", "translation": "<exact words from the NEW translation>", "problem": "<one sentence in English>"}]}',
    'If every problem is fixed, return {"issues": []}.',
  ].join("\n");
}

export function verifyUser(items) {
  return items
    .map((t, k) => [`ITEM ${k + 1}`, `SOURCE:\n${t.source}`, `OLD TRANSLATION:\n${t.before}`, `PROBLEMS:\n${t.problems.map((p) => `- ${p.type}: ${p.problem}`).join("\n")}`, `NEW TRANSLATION:\n${t.fixed}`].join("\n"))
    .join("\n\n");
}

// Correct one paragraph against the problems the reviewer found in it.
export function correctUser({ source, translation, problems, entries }) {
  return [
    "A reviewer found these errors in the translation of one paragraph:",
    problems.map((p) => `- ${p.type}: ${p.problem}${p.source ? ` (source: "${p.source}")` : ""}${p.translation ? ` (translation: "${p.translation}")` : ""}`).join("\n"),
    "Correct these errors and change nothing else. Keep it one paragraph.",
    glossaryBlock(entries),
    `SOURCE PARAGRAPH:\n<<<\n${source}\n>>>`,
    `TRANSLATED PARAGRAPH:\n<<<\n${translation}\n>>>`,
    "Output only the corrected paragraph.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// A whole-chunk fix often copies a two-letter glitch (Armenian "ակ" inside a Thai word) straight
// back, so stray script left after it is fixed on just the words around it.
export function patchUser({ snippet, bad, tgtLang }) {
  return [
    `This short ${L(tgtLang)} snippet from a novel translation contains "${bad}", which is not ${L(tgtLang)} script (a glitch, often letters that look like ${L(tgtLang)} ones).`,
    `Rewrite the snippet with "${bad}" replaced by the ${L(tgtLang)} letters or word that was meant, or removed if it is noise. Change nothing else.`,
    `SNIPPET:\n<<<\n${snippet}\n>>>`,
    "Output only the corrected snippet.",
  ].join("\n\n");
}

// Pull the first JSON object out of a model reply (some wrap it in ``` fences or add a sentence).
export function parseJSON(reply) {
  const s = String(reply);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI ไม่ได้ตอบเป็น JSON");
  return JSON.parse(s.slice(start, end + 1));
}

// Models sometimes echo the <<< >>> markers or a label; strip them.
export function cleanReply(reply) {
  return String(reply)
    .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, "")
    .replace(/^\s*(?:<<<|>>>)\s*$/gm, "")
    .replace(/^\s*(?:PASSAGE TO TRANSLATE|TRANSLATION|REVISED PASSAGE|CORRECTED PASSAGE)\s*:?\s*\n/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
