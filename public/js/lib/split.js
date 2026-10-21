// Split imported text into chapters, and chapters into chunks small enough for one request.

const NUM = "0-9０-９零〇一二三四五六七八九十百千两兩";
const HEADINGS = [
  new RegExp(`^\\s*第\\s*[${NUM}]+\\s*[章回节節话話卷集幕]`), // 第12章 / 第一回 / 第3話
  /^\s*제\s*\d+\s*[화장편부]/, // 제12화
  /^\s*\d+\s*[화話]\s*$/, // 12화
  /^\s*(?:chapter|ch\.|episode|ep\.)\s*\d+/i, // Chapter 12
  /^\s*(?:chương|chuong)\s+[\dIVXLC]+/i, // Chương 12
  /^\s*(?:bab)\s+\d+/i, // Bab 12
  /^\s*(?:capítulo|capitulo|chapitre|kapitel|глава)\s+\S+/i,
  /^\s*ตอนที่\s*\d+/, // ตอนที่ 12
  /^\s*(?:[IVXLC]+|[一二三四五六七八九十]+)\s*[.．、]?\s*$/, // bare I. / II / 一 / 二 on their own line
];

const SEPARATOR = /^\s*(?:={3,}|-{3,}|\*{3,}|#{3,})\s*$/;

export function isHeading(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  return HEADINGS.some((re) => re.test(t));
}

export function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Returns [{title, text}]. Headings start a new chapter; a line of === also does.
export function splitChapters(raw, fallbackTitle = "ตอนที่ 1") {
  const text = normalizeText(raw);
  if (!text) return [];
  const lines = text.split("\n");
  const chapters = [];
  let cur = null;
  const push = () => {
    if (cur && cur.lines.join("").trim()) chapters.push({ title: cur.title, text: cur.lines.join("\n").trim() });
  };
  for (const line of lines) {
    if (SEPARATOR.test(line)) {
      push();
      cur = { title: "", lines: [] };
    } else if (isHeading(line)) {
      // A heading right after a separator names that chapter instead of opening another.
      if (cur && !cur.title && !cur.lines.join("").trim()) cur.title = line.trim();
      else {
        push();
        cur = { title: line.trim(), lines: [] };
      }
    } else {
      if (!cur) cur = { title: "", lines: [] };
      cur.lines.push(line);
    }
  }
  push();
  return chapters.map((c, i) => ({
    title: c.title || (chapters.length === 1 ? fallbackTitle : `ตอนที่ ${i + 1}`),
    text: c.text,
  }));
}

export const paragraphs = (text) =>
  normalizeText(text)
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean);

// Greedy paragraph packing; a single overlong paragraph is cut at sentence ends.
export function chunkText(text, maxChars) {
  const parts = [];
  for (const p of paragraphs(text)) {
    if (p.length <= maxChars) parts.push(p);
    else parts.push(...splitSentences(p, maxChars));
  }
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const p of parts) {
    if (len + p.length > maxChars && cur.length) {
      chunks.push(cur.join("\n\n"));
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length;
  }
  if (cur.length) chunks.push(cur.join("\n\n"));
  return chunks;
}

function splitSentences(p, maxChars) {
  const sentences = p.match(/[^。！？!?.…」』]+[。！？!?.…」』]*/g) || [p];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > maxChars) {
      out.push(cur);
      cur = "";
    }
    cur += s;
    while (cur.length > maxChars) {
      out.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur) out.push(cur);
  return out;
}
