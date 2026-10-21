// Import .txt/.docx/.epub and export .txt/.md/.docx/.epub/.zip. JSZip and mammoth load on demand.

const JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";

const loaded = {};
function script(src, global) {
  loaded[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(window[global]);
    s.onerror = () => reject(new Error(`โหลด ${global} ไม่ได้ (ต่อเน็ตอยู่ไหม?)`));
    document.head.append(s);
  });
  return loaded[src];
}
const zipLib = () => script(JSZIP, "JSZip");

// ---------- import ----------

export async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const mammoth = await script(MAMMOTH, "mammoth");
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return [{ name: file.name, text: value }];
  }
  if (name.endsWith(".epub")) return readEpub(file);
  return [{ name: file.name, text: decode(await file.arrayBuffer()) }];
}

// UTF-8 first; fall back to the legacy encodings Chinese/Japanese/Korean/Thai txt files often use.
function decode(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    for (const enc of ["gb18030", "big5", "shift_jis", "euc-kr", "windows-874"]) {
      try {
        const t = new TextDecoder(enc, { fatal: true }).decode(buf);
        if (t) return t;
      } catch {
        /* try the next one */
      }
    }
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function readEpub(file) {
  const JSZip = await zipLib();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = await zip.file("META-INF/container.xml").async("text");
  const opfPath = /full-path="([^"]+)"/.exec(container)[1];
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async("text"), "application/xml");
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const items = Object.fromEntries([...opf.getElementsByTagName("item")].map((i) => [i.getAttribute("id"), i.getAttribute("href")]));
  const out = [];
  for (const ref of opf.getElementsByTagName("itemref")) {
    const href = items[ref.getAttribute("idref")];
    const f = href && zip.file(dir + decodeURIComponent(href));
    if (!f) continue;
    const doc = new DOMParser().parseFromString(await f.async("text"), "application/xhtml+xml");
    doc.querySelectorAll("rt, rp, script, style").forEach((n) => n.remove());
    const title = doc.querySelector("h1, h2, h3, title")?.textContent.trim() || "";
    const blocks = [...doc.querySelectorAll("p, h1, h2, h3, h4, div:not(:has(p, div))")].map((n) => n.textContent.trim()).filter(Boolean);
    const text = blocks.join("\n\n");
    if (text.length > 20) out.push({ name: title || href, text, chapter: true });
  }
  return out;
}

// ---------- export ----------

export function download(name, data, type = "text/plain;charset=utf-8") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "novel";

const chapterTitle = (c) => c.titleT || c.title;

export function toText(chapters, { md = false, bilingual = false } = {}) {
  return chapters
    .map((c) => {
      const head = md ? `## ${chapterTitle(c)}` : chapterTitle(c);
      const body = bilingual ? interleave(c.text, c.translation) : c.translation;
      return `${head}\n\n${body}`;
    })
    .join("\n\n\n");
}

function interleave(src, out) {
  const a = src.split(/\n\s*\n/);
  const b = out.split(/\n\s*\n/);
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => [a[i], b[i]].filter(Boolean).join("\n")).join("\n\n");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function toDocx(title, chapters) {
  const JSZip = await zipLib();
  const zip = new JSZip();
  const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const body = chapters
    .map((c, i) => (i ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : "") + para(chapterTitle(c), "Heading1") + c.translation.split(/\n\s*\n|\n/).filter(Boolean).map((p) => para(p)).join(""))
    .join("");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="TH Sarabun New" w:hAnsi="TH Sarabun New" w:cs="TH Sarabun New" w:eastAsia="TH Sarabun New"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:bidi="th-TH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/><w:ind w:firstLine="720"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style></w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${para(title, "Heading1")}${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

export async function toEpub(title, chapters, lang = "th") {
  const JSZip = await zipLib();
  const zip = new JSZip();
  const id = `urn:uuid:${crypto.randomUUID()}`;
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const files = chapters.map((c, i) => {
    const name = `ch${String(i + 1).padStart(4, "0")}.xhtml`;
    const body = c.translation.split(/\n\s*\n|\n/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("\n");
    zip.file(`OEBPS/${name}`, `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}"><head><title>${esc(chapterTitle(c))}</title><style>body{line-height:1.8}p{text-indent:2em;margin:0 0 .6em}h1{text-align:center}</style></head><body><h1>${esc(chapterTitle(c))}</h1>\n${body}</body></html>`);
    return { name, title: chapterTitle(c) };
  });
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}"><head><title>${esc(title)}</title></head><body><nav epub:type="toc"><h1>สารบัญ</h1><ol>${files.map((f) => `<li><a href="${f.name}">${esc(f.title)}</a></li>`).join("")}</ol></nav></body></html>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>${lang}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${files.map((f, i) => `<item id="c${i}" href="${f.name}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${files.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
}

export async function toZip(files) {
  const JSZip = await zipLib();
  const zip = new JSZip();
  for (const [name, text] of files) zip.file(name, text);
  return zip.generateAsync({ type: "blob" });
}
