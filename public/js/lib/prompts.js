// Prompt builders. Instructions are in English (models follow them most reliably);
// the output language comes from the project settings.

import { langByCode, genreById, NAME_STYLES } from "./langs.js";
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
    "1. Translate every sentence. Do not summarize, skip, merge away or add content. Keep the paragraphs in the same order and separate paragraphs with one blank line.",
    "2. When a term from the GLOSSARY appears in the passage, write its locked translation exactly as given, character for character. Never write a glossary translation for something that is not in the passage.",
    `3. Names and terms not in the glossary: ${nameRule(s)} Prefer a well-known ${tgt} rendering when one exists; translate meaningful epithets and titles by meaning. Keep each one the same everywhere in the passage.`,
    `4. Style: ${genreById(s.genre).style}`,
    `5. ${quoteRule(s.tgtLang)}`,
    "6. Keep pronouns, forms of address and politeness levels consistent with the story context and the notes in the glossary.",
    "7. Output only the translated passage: no title, no notes, no explanations, no source text.",
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
  for (const t of issues.leftovers) lines.push(`- "${t}" was left untranslated. Translate it.`);
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
    "Terms to list: names of people (also nicknames and titles used as names), places, sects/clans/organizations, martial arts and cultivation techniques, cultivation ranks, magic items and weapons, and other invented terms that must stay consistent across chapters.",
    "Do not list ordinary words. Do not list terms that are already in the KNOWN TERMS list. Use the exact source spelling found in the chapter.",
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
