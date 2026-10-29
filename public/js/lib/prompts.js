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

// Rules the AI drew from this translator's own corrections (see learn.js). They come after the general
// rules and win over them.
function learnedBlock(s) {
  const rules = (s.memory?.rules || []).map((r) => r.text).filter(Boolean);
  return rules.length ? `\nRules learned from this translator's own corrections (they override the general rules above):\n${rules.map((r) => `- ${r}`).join("\n")}` : "";
}

export function translateSystem(s) {
  const tgt = L(s.tgtLang);
  return [
    `You are an experienced literary translator of web novels from ${L(s.srcLang)} into ${tgt}.`,
    `Translate the passage the user gives into fluent, natural ${tgt} that reads like a professionally published novel, not like a machine translation.`,
    "",
    "Rules:",
    "1. Translate every sentence. Do not summarize, skip, merge away or add content. The source paragraphs are numbered [1], [2], …: write exactly one translated paragraph for each, in the same order, starting with the same number in brackets, separated by one blank line. Never move a sentence into another paragraph's number.",
    "Faithfulness comes before fluency: keep the exact meaning of each sentence (who does what, facts, numbers, negation, tense, the order of events, the images and comparisons the author used, the tone). Do not soften, exaggerate, modernize, explain or replace them with different ones. Make it read naturally only through word choice and word order, never by changing what is said.",
    "2. When a term from the GLOSSARY appears in the passage, write its locked translation exactly as given, character for character. Never write a glossary translation for something that is not in the passage.",
    `3. Names and terms not in the glossary: ${nameRule(s)} Prefer a well-known ${tgt} rendering when one exists; translate meaningful epithets and titles by meaning. Keep each one the same everywhere in the passage.`,
    `Skill, technique, spell and item names not in the glossary: ${skillRule(s)}`,
    `4. Style: ${genreById(s.genre).style}`,
    `5. ${quoteRule(s.tgtLang)}`,
    "6. Keep pronouns, forms of address and politeness levels consistent with the story context and the notes in the glossary. Where the source leaves something open (who is speaking, a pronoun, a vague phrase), keep it open rather than inventing an explanation.",
    "7. Output only the translated passage: no title, no notes, no explanations, no source text.",
    LANG_NOTES[s.srcLang] ? `8. ${LANG_NOTES[s.srcLang]}` : "",
    s.custom ? `\nExtra instructions from the translator:\n${s.custom}` : "",
    learnedBlock(s),
  ]
    .filter((x) => x !== "")
    .join("\n");
}

// The translator's corrections of similar passages: what the AI wrote and what the person changed it to.
export function examplesBlock(examples) {
  if (!examples?.length) return "";
  const one = (e, i) => `EXAMPLE ${i + 1}\nSource: ${e.source}\nMachine draft (rejected): ${e.ai}\nTranslator's correction (follow this): ${e.fixed}`;
  return `HOW THIS TRANSLATOR CORRECTS THE AI (learn the word choices, names and level of faithfulness; reuse the corrected wording where the same words appear; do not translate these examples):\n${examples.map(one).join("\n\n")}`;
}

export function translateUser({ chunk, entries, summary, previous, examples }) {
  const parts = [];
  if (summary) parts.push(`STORY SO FAR (context only, do not translate):\n${summary}`);
  const g = glossaryBlock(entries);
  if (g) parts.push(g);
  const x = examplesBlock(examples);
  if (x) parts.push(x);
  if (previous) parts.push(`END OF THE PREVIOUS PASSAGE, ALREADY TRANSLATED (for continuity only, do not repeat it):\n${previous}`);
  parts.push(`PASSAGE TO TRANSLATE:\n<<<\n${numberParas(chunk)}\n>>>`);
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
    "- Keep the same paragraphs in the same order, each starting with its [n] number from the source, separated by one blank line.",
    "Do not add events, explanations or commentary, and never change the meaning to make a sentence sound nicer. Output only the revised passage.",
    s.custom ? `\nExtra instructions from the translator:\n${s.custom}` : "",
    learnedBlock(s),
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export function polishUser({ chunk, draft, entries, examples }) {
  return [glossaryBlock(entries), examplesBlock(examples), `SOURCE:\n<<<\n${numberParas(chunk)}\n>>>`, `DRAFT TRANSLATION:\n<<<\n${numberParas(draft)}\n>>>`].filter(Boolean).join("\n\n");
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
    `SOURCE:\n<<<\n${numberParas(chunk)}\n>>>`,
    `DRAFT TRANSLATION:\n<<<\n${numberParas(draft)}\n>>>`,
    "Output only the corrected passage, keeping each paragraph's [n] number.",
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
    "Terms to list: names of people (also nicknames and titles used as names), places, sects/clans/organizations, martial arts and cultivation techniques, power levels (cultivation realms and their stages, ranks, grades, classes, levels such as 筑基期, 金丹, 斗者, 三星, S級, 레벨), magic items and weapons, and other invented terms that must stay consistent across chapters. List the main character first.",
    "Power levels form a ladder: translate every level of the same ladder the same way, by meaning (never transliterate one level while translating the one below it by meaning), use the same word for 期/境/级/阶/星 each time, and keep the stage words consistent (初期, 中期, 后期, 巅峰 = ขั้นต้น, ขั้นกลาง, ขั้นปลาย, ขั้นสูงสุด in Thai). Give power levels the type \"title\".",
    "Do not list ordinary words. Do not list terms that are already in the KNOWN TERMS list. Use the exact source spelling found in the chapter.",
    `Give exactly one ${tgt} translation per term, written fully in ${tgt} script (no alternatives separated by \"/\", no source characters left inside).`,
    "List each name on its own: split a chain such as 東京開封府汴梁宣武軍 into its separate place names, and list a person apart from the title in front of them unless the title is part of how they are always called.",
    `For the translation of names: ${nameRule(s)}`,
    `If a name, place or title already has a well-known ${tgt} rendering (from classic published translations or common use), use that rendering.`,
    "Epithets, titles and nicknames that carry a meaning (for example 美猴王 \"Handsome Monkey King\", 齊天大聖 \"Great Sage Equal to Heaven\") are translated by meaning, not transliterated.",
    `Skill, technique, spell, rank and item names: ${skillRule(s)}`,
    learnedBlock(s),
  ].join("\n");
}

// How to render invented technique names. Thai readers of translated novels expect them translated by
// meaning, with every part of the name kept (降龍十八掌 = สิบแปดฝ่ามือพิชิตมังกร, not "ฝ่ามือมังกร").
export function skillRule(s) {
  const base = "translate every meaningful part of the name, in the natural word order of the target language, without dropping, adding or swapping parts; transliterate only the parts that are personal or place names; if the source gives a level or number (第三式, 九重, Lv.3), keep it.";
  if (s.tgtLang === "th") return `${base} Cultivation realms are translated by meaning too, all of them (金丹 → แก่นทอง, not จินตาน). Use the wording of Thai translated novels (for example 降龍十八掌 → สิบแปดฝ่ามือพิชิตมังกร, Fireball → ลูกไฟ). Keep English game-style skill names in English only if the source writes them in English letters.`;
  return base;
}

// Learn from a translator's corrections: what to lock in the glossary and which general rules follow.
export function learnSystem(s) {
  const tgt = L(s.tgtLang);
  return [
    `A human translator corrected machine translations of a ${L(s.srcLang)} novel into ${tgt}. Work out what the AI should do differently from now on.`,
    "For each item you get the source paragraph, the machine draft and the translator's correction.",
    'Return JSON only: {"terms": [{"source": "<name or term exactly as in the source>", "target": "<the translator\'s rendering, copied exactly from the correction>", "type": "person|place|skill|org|item|title|other", "note": "<short note or empty>"}], "rules": ["<one short rule>"]}',
    "terms: every name, title, skill/technique, item, place or other fixed term whose rendering the translator changed. Copy both sides character for character. Do not list ordinary words.",
    `rules: general lessons that will apply to other chapters too, written in ${tgt} as short imperative sentences (for example about pronouns and forms of address, faithfulness, a word the AI keeps choosing wrongly, how to render a kind of expression). At most 5. Do not repeat a rule from EXISTING RULES, do not restate a single term, and do not write a rule from a change that was only a typo.`,
    'If the corrections teach nothing general, return "rules": [].',
  ].join("\n");
}

export function learnUser({ corrections, rules, entries }) {
  return [
    rules?.length ? `EXISTING RULES:\n${rules.map((r) => `- ${r}`).join("\n")}` : "",
    glossaryBlock(entries),
    corrections.map((c, i) => `ITEM ${i + 1}\nSOURCE:\n${c.source}\nMACHINE DRAFT:\n${c.ai}\nTRANSLATOR'S CORRECTION:\n${c.fixed}`).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
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

// Paragraphs are numbered in requests so the reply can be put back paragraph for paragraph: models
// split long paragraphs and merge short ones, and the source and translation then no longer line up.
const PARA_SPLIT = /\n\s*\n|\n/;
const MARK = /^\s*\[(\d+)\]\s*/;
export const numberParas = (text) => String(text).split(PARA_SPLIT).map((p) => p.trim()).filter(Boolean).map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
export const stripMarks = (text) => String(text).split("\n").map((l) => l.replace(MARK, "")).join("\n");

// A numbered reply as one paragraph per source paragraph. Lines under the same number are joined (a split
// paragraph); a missing number leaves its paragraph out, which the structure check then reports and repairs.
// A reply without numbers is used as it is.
export function alignedReply(reply, source, tgtLang) {
  const text = cleanReply(reply);
  const lines = text.split(PARA_SPLIT).map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => MARK.test(l))) return text;
  const n = String(source).split(PARA_SPLIT).filter((p) => p.trim()).length;
  const by = new Map();
  let cur = 1;
  for (const l of lines) {
    const m = MARK.exec(l);
    if (m) cur = Math.min(Math.max(1, Number(m[1])), n);
    const body = l.replace(MARK, "").trim();
    if (body) by.set(cur, [...(by.get(cur) || []), body]);
  }
  const glue = tgtLang === "zh" || tgtLang === "ja" ? "" : " ";
  return Array.from({ length: n }, (_, i) => by.get(i + 1)?.join(glue)).filter(Boolean).join("\n\n");
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
