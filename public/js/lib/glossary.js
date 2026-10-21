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

// Scripts that should not appear in a translation into a given language. Models occasionally leak
// a character from an unrelated script too (a Hangul syllable inside a Japanese→Thai name), so all are checked.
const SCRIPTS = {
  han: /[\u4e00-\u9fff\u3400-\u4dbf]+/g,
  kana: /[\u3040-\u30ff]+/g,
  hangul: /[\uac00-\ud7af\u1100-\u11ff]+/g,
  cyrillic: /[\u0400-\u04ff]{3,}/g,
};
const ALLOWED = { zh: ["han"], ja: ["han", "kana"], ko: ["hangul", "han"], ru: ["cyrillic"] };

function foreignRuns(text, tgtLang) {
  const allowed = ALLOWED[tgtLang] || [];
  const out = new Set();
  for (const [name, re] of Object.entries(SCRIPTS)) {
    if (allowed.includes(name)) continue;
    for (const m of text.match(re) || []) out.add(m);
  }
  return [...out];
}

// Compare a translation with its source: locked terms that did not come through,
// and runs of foreign script left in the text.
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
  const leftovers = srcLang === tgtLang ? [] : foreignRuns(translated, tgtLang);
  return { missing, leftovers, ok: missing.length === 0 && leftovers.length === 0 };
}

const FOREIGN = { ko: /[\uac00-\ud7af\u1100-\u11ff]/, ja: /[\u3040-\u30ff]/, zh: /[\u4e00-\u9fff]/ };

// Clean up a translation proposed by the AI: keep the first of "A / B" alternatives, and reject
// renderings that still carry source script (e.g. "ประตูทง소문"), which would be locked in for good.
export function cleanProposedTarget(target, tgtLang) {
  let t = String(target ?? "").trim();
  t = t.split(/\s*[\/／|]\s*|\s+(?:or|หรือ)\s+/)[0].replace(/^["“'‘(（]+|["”'’)）]+$/g, "").trim();
  for (const [lang, re] of Object.entries(FOREIGN)) {
    if (lang === tgtLang || (lang === "zh" && tgtLang === "ja")) continue;
    if (re.test(t)) return "";
  }
  return t;
}

// Add proposed terms whose source is not in the glossary yet. Returns the entries added.
export function mergeTerms(glossary, proposed, status, tgtLang = "th") {
  const known = new Set(glossary.map((e) => e.source));
  const added = [];
  for (const p of proposed || []) {
    const e = makeEntry({ ...p, target: cleanProposedTarget(p?.target, tgtLang), status });
    if (!e.source || !e.target || known.has(e.source)) continue;
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
