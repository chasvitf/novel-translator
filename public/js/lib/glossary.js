// Glossary: locked translations for names, places, techniques; matching and consistency checks.

export const TERM_TYPES = [
  { id: "person", name: "ตัวละคร" },
  { id: "place", name: "สถานที่" },
  { id: "skill", name: "วิชา / กระบวนท่า" },
  { id: "org", name: "สำนัก / องค์กร" },
  { id: "item", name: "ไอเทม / อาวุธ" },
  { id: "title", name: "ยศ / ตำแหน่ง / คำเรียก" },
  { id: "other", name: "คำเฉพาะอื่นๆ" },
];

export const typeName = (id) => (TERM_TYPES.find((t) => t.id === id) || TERM_TYPES.at(-1)).name;

const norm = (s) => String(s ?? "").trim();
const isLatin = (s) => /^[\p{Script=Latin}\d\s'’.\-]+$/u.test(s);

let seq = 0;
export const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeEntry(fields) {
  return {
    id: fields.id || newId(),
    source: norm(fields.source),
    target: norm(fields.target),
    type: TERM_TYPES.some((t) => t.id === fields.type) ? fields.type : "other",
    note: norm(fields.note),
    status: fields.status === "pending" ? "pending" : "locked",
  };
}

// Positions where `needle` occurs in `hay`; Latin terms match whole words, case-insensitively.
function occurrences(hay, needle) {
  const out = [];
  if (!needle) return out;
  if (isLatin(needle)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of hay.matchAll(re)) out.push([m.index, m.index + m[0].length]);
    return out;
  }
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push([i, i + needle.length]);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Occurrences of each entry in `text`, not counting places covered by a longer entry
// (so 猴王 inside 美猴王 does not demand its own translation).
export function countInText(entries, text, field = "source") {
  const sorted = [...entries].filter((e) => e[field]).sort((a, b) => b[field].length - a[field].length);
  const taken = [];
  const counts = new Map();
  for (const e of sorted) {
    let n = 0;
    for (const [s, t] of occurrences(text, e[field])) {
      if (taken.some(([a, b]) => s >= a && t <= b)) continue;
      taken.push([s, t]);
      n++;
    }
    if (n) counts.set(e.id, n);
  }
  return counts;
}

// Entries that appear in the text, longest first. Only these go into a prompt:
// listing names that are not in the passage makes some models insert them.
export function relevantEntries(entries, text) {
  const counts = countInText(entries, text);
  return entries.filter((e) => counts.has(e.id)).sort((a, b) => b.source.length - a.source.length);
}

// Letters allowed in a translation into each language (anything else is a leak: "โมมิเอ보ชิ",
// "กรมอัศతรสวรรค์" with a Telugu letter, kanji left in Thai). Latin is allowed everywhere;
// stray Latin words are checked separately.
const SCRIPT_OF = {
  th: ["Thai"],
  zh: ["Han"],
  ja: ["Han", "Hiragana", "Katakana"],
  ko: ["Hangul", "Han"],
  ru: ["Cyrillic"],
};
const letterRe = (lang) => {
  const ok = ["Latin", ...(SCRIPT_OF[lang] || [])].map((sc) => `\\p{Script=${sc}}`).join("");
  return new RegExp(`(?:(?![${ok}])\\p{L})+`, "gu");
};

function foreignRuns(text, tgtLang) {
  return [...new Set(text.match(letterRe(tgtLang)) || [])];
}

// Latin words in a Thai (or other non-Latin) translation that the source does not contain either:
// models sometimes drop an English gloss into the text ("Coontail").
const NON_LATIN_TARGETS = new Set(["th", "zh", "ja", "ko", "ru"]);
const THAI_NEAR = "\\p{Script=Thai}";

// Where a leftover sits: a letter glued to Thai is found there, not at its first appearance in the text
// (a stray "i" in "ด้วยiมาด" once sent the fix to an "i" inside an earlier word).
export function findLeak(text, bad) {
  const e = escapeRe(bad);
  const glued = new RegExp(`(?<=${THAI_NEAR})${e}|${e}(?=${THAI_NEAR})`, "u").exec(text);
  return glued ? glued.index : text.indexOf(bad);
}
function strayLatin(source, translated, entries, tgtLang) {
  if (!NON_LATIN_TARGETS.has(tgtLang)) return [];
  const src = source.toLowerCase();
  const allowed = entries.map((e) => `${e.target} ${e.source}`.toLowerCase()).join(" ");
  // Any Latin letters, accented ones included: Vietnamese "đồng thời" once leaked into a Thai translation.
  const words = (translated.match(/\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]{2,}/gu) || []).map((w) => w.replace(/['’-]+$/, "")).filter((w) => w.length >= 3);
  // Thai has no spaces inside words, so Latin letters touching Thai ones are a glitch ("h้อย"), however short.
  if (tgtLang === "th") words.push(...(translated.match(new RegExp(`(?<=${THAI_NEAR})[A-Za-z]+|[A-Za-z]+(?=${THAI_NEAR})`, "gu")) || []));
  // Allowed only as a whole word of the source or glossary: a lone "i" is not allowed because "Hit" has one.
  const hasWord = (text, w) => new RegExp(`(?<![\\p{Script=Latin}\\p{M}])${escapeRe(w.toLowerCase())}(?![\\p{Script=Latin}\\p{M}])`, "u").test(text);
  return [...new Set(words.filter((w) => !hasWord(src, w) && !hasWord(allowed, w) && !/^(?:OK|AI|CEO|ID|DNA|GPS|TV|VIP)$/i.test(w)))];
}

// Paragraph-level checks for content that went missing, which name checks cannot see. The translator
// is told to keep one paragraph per source paragraph, so paragraph i of the output answers paragraph i of
// the source. Lengths are compared with this passage's own output/source ratio, never a fixed ratio
// (Thai runs about twice as long as Chinese and shorter than English).
// Speech: a quoted span with sentence punctuation inside (“你是誰？”), or an opening quote running on into the
// next paragraph. Names and terms in quotes (“三界融合之战”, “真香”) have none, and Thai rightly drops those marks.
const SPEECH = /[“「『"][^”」』"]*[，。！？…!?,.~～][^”」』"]*(?:[”」』"]|$)/;
const OUT_QUOTE = /["“”「」『』«»‘’]/;
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;
const paras = (s) => String(s).split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
const brief = (s) => (s.length > 80 ? s.slice(0, 80) + "…" : s);

export function checkStructure(source, translated) {
  const src = paras(source);
  const out = paras(translated);
  // Fewer paragraphs can mean lost content. More is usually a long paragraph or a poem split up (measured
  // on real Gemini output: 35 → 81), which loses nothing, so it is not flagged; alignment is then unknown.
  if (out.length < src.length) return [{ kind: "paragraphs", src: `${src.length}`, out: `${out.length}` }];
  if (out.length !== src.length) return [];
  const ratio = out.join("").length / Math.max(1, src.join("").length);
  // Whether output paragraph o reads like the translation of source paragraph s.
  const fits = (o, s) => {
    if (!out[o] || !src[s]) return false;
    const r = out[o].length / src[s].length / ratio;
    return r > 0.5 && r < 2 && (!SPEECH.test(src[s]) || OUT_QUOTE.test(out[o]));
  };
  // A paragraph split in one place and two merged in another keep the count but shift the ones between
  // (seen in a user's novel); a shifted pair is not a missing or broken paragraph, and no fix can change it.
  const shifted = (i) => (fits(i, i - 1) && fits(i + 1, i)) || (fits(i, i + 1) && fits(i - 1, i));
  const found = [];
  src.forEach((s, i) => {
    const r = out[i].length / s.length;
    // English or numbers kept as they are ("Four-Hit-Combos！") do not grow like the rest of the text.
    const short = s.length >= 10 && r < ratio * 0.3 && !LATIN_ONLY.test(s);
    const lostQuotes = SPEECH.test(s) && !OUT_QUOTE.test(out[i]);
    if ((short || lostQuotes) && shifted(i)) return;
    if (short) found.push({ kind: "short", para: i, src: brief(s), out: brief(out[i]) });
    else if (lostQuotes) found.push({ kind: "dialogue", para: i, src: brief(s), out: brief(out[i]) });
  });
  return found;
}

// Problems a chapter is flagged for: glossary and script checks, structure checks, and what the
// independent reviewer found and could not fix.
export const issueCount = (issues, review) =>
  (issues ? issues.missing.length + issues.leftovers.length + (issues.structure?.length || 0) : 0) + (review?.unresolved?.length || 0);

// Compare a translation with its source: locked terms that did not come through,
// runs of foreign script left in the text, and missing or broken paragraphs.
export function checkTranslation(source, translated, entries, srcLang, tgtLang) {
  const used = relevantEntries(entries, source);
  const srcCounts = countInText(used, source);
  const lower = translated.toLowerCase();
  const missing = [];
  for (const e of used) {
    if (!e.target) continue;
    const found = isLatin(e.target) ? occurrences(translated, e.target).length : lower.split(e.target.toLowerCase()).length - 1;
    if (found === 0) missing.push({ entry: e, expected: srcCounts.get(e.id) || 1 });
  }
  const leftovers = srcLang === tgtLang ? [] : [...foreignRuns(translated, tgtLang), ...strayLatin(source, translated, entries, tgtLang)];
  const structure = checkStructure(source, translated);
  return { missing, leftovers, structure, ok: missing.length === 0 && leftovers.length === 0 && structure.length === 0 };
}

// Clean up a translation proposed by the AI: keep the first of "A / B" alternatives, and reject
// renderings with letters from another script (e.g. "ประตูทง소문"), which would be locked in for good.
export function cleanProposedTarget(target, tgtLang) {
  let t = String(target ?? "").trim();
  t = t.split(/\s*[\/／|]\s*|\s+(?:or|หรือ)\s+/)[0];
  t = t.replace(/\s*[(（[].*$/, ""); // "ท้าวตั๋วหลัวหลี่ (ท้าวเวสสุวรรณ)" → keep the name, drop the aside
  t = t.replace(/^["“'‘]+|["”'’]+$/g, "").trim();
  return foreignRuns(t, tgtLang).length ? "" : t;
}

// Add proposed terms whose source is not in the glossary yet. Returns the entries added.
export function mergeTerms(glossary, proposed, status, tgtLang = "th") {
  const known = new Set(glossary.map((e) => e.source));
  const added = [];
  for (const p of proposed || []) {
    const e = makeEntry({ ...p, target: cleanProposedTarget(p?.target, tgtLang), status });
    if (!e.source || !e.target || known.has(e.source)) continue;
    if (/[、,，;；]/.test(e.source)) continue; // several names in one entry ("龐、劉、苟…") can never be checked
    if (/[“”「」『』"《》]/.test(e.source)) continue; // a description around a quoted nickname ("A-39B“大嘴怪”轻型…攻击机") is never matched word for word
    if (e.source.length > 40 || e.target.length > 60) continue;
    known.add(e.source);
    glossary.push(e);
    added.push(e);
  }
  return added;
}

// ---- CSV (opens in Excel / Google Sheets) ----

const CSV_HEAD = ["source", "target", "type", "note", "status"];

export function toCSV(entries) {
  const cell = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = entries.map((e) => CSV_HEAD.map((k) => cell(e[k] ?? "")).join(","));
  return "﻿" + [CSV_HEAD.join(","), ...rows].join("\n");
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === "\t") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const clean = rows.filter((r) => r.some((c) => c.trim()));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase());
  const hasHead = head.includes("source") || head.includes("ต้นฉบับ");
  const idx = (names, fallback) => {
    const i = head.findIndex((h) => names.includes(h));
    return hasHead ? i : fallback;
  };
  const col = {
    source: idx(["source", "ต้นฉบับ"], 0),
    target: idx(["target", "คำแปล"], 1),
    type: idx(["type", "ประเภท"], 2),
    note: idx(["note", "หมายเหตุ"], 3),
    status: idx(["status", "สถานะ"], 4),
  };
  const typeFromName = (v) => {
    const t = TERM_TYPES.find((x) => x.id === v || x.name === v || x.name.split(" / ").includes(v));
    return t ? t.id : "other";
  };
  return (hasHead ? clean.slice(1) : clean)
    .map((r) =>
      makeEntry({
        source: r[col.source],
        target: r[col.target],
        type: typeFromName(norm(r[col.type])),
        note: r[col.note],
        status: norm(r[col.status]) === "pending" ? "pending" : "locked",
      }),
    )
    .filter((e) => e.source);
}
