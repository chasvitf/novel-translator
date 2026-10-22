// Real-API test of a whole book: one file → splitChapters → several chapters translated at once with a
// shared glossary, like the app's "แปลพร้อมกัน" with the paid-key option (300 ms spacing).
// Usage: node scripts/run_parallel.mjs [lanes] [files...]   (GEMINI_API_KEY from .env)
import fs from "node:fs";
import path from "node:path";
import { createCaller, PROVIDERS } from "../public/js/lib/providers.js";
import { translateChapter, newChapter, recheckChapter, fixChapter } from "../public/js/lib/pipeline.js";
import { splitChapters } from "../public/js/lib/split.js";
import { checkTranslation } from "../public/js/lib/glossary.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const m = /^(\w+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2];
}
const [lanesArg = "3", ...files] = process.argv.slice(2);
const lanes = Number(lanesArg);
const list = files.length ? files : ["zh-xiyouji-01.txt", "zh-xiyouji-02.txt", "zh-xiyouji-03.txt", "zh-xiyouji-04.txt", "zh-xiyouji-05.txt"];
// The cleaned corpus files have no chapter headings, so add the 第N回 headings a real book has.
const ZH = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const book = list.map((f, i) => `第${ZH[i] || i + 1}回\n\n${fs.readFileSync(path.join(root, "corpus", f), "utf8")}`).join("\n\n");

const project = { name: "parallel", srcLang: "zh", tgtLang: "th", genre: "xianxia", nameStyle: "hokkien", custom: "", polish: false, autoFix: true, autoTerms: "auto", glossary: [], chapters: [] };
project.chapters = splitChapters(book).map((c) => newChapter(c.title, c.text));
console.log(`split into ${project.chapters.length} chapters: ${project.chapters.map((c) => c.title.slice(0, 12)).join(" | ")}`);

const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const exhaustedFile = path.join(root, "corpus", "out", `exhausted-${day}.json`);
const exhausted = new Set(fs.existsSync(exhaustedFile) ? JSON.parse(fs.readFileSync(exhaustedFile, "utf8")) : []);
let calls = 0, inflight = 0, peak = 0, rateWaits = 0;
const used = {};
const base = createCaller({ provider: "gemini", model: "gemini-3.5-flash", key: process.env.GEMINI_API_KEY, fallbackModels: PROVIDERS.gemini.models, minIntervalMs: 300 }, {
  exhausted,
  onWait: (ms, why) => { if (/429|ถี่|rate/i.test(why)) rateWaits++; console.log(`   … wait ${Math.round(ms / 1000)}s (${why.slice(0, 70)})`); },
  onSwitch: (from, to, why) => { console.log(`   ⇄ ${from} → ${to} (${why.slice(0, 50)})`); fs.writeFileSync(exhaustedFile, JSON.stringify([...exhausted])); },
});
const call = async (req) => {
  calls++; inflight++; peak = Math.max(peak, inflight);
  try { const r = await base(req); used[r.model] = (used[r.model] || 0) + 1; return r; } finally { inflight--; }
};

const t0 = Date.now();
const order = [];
let next = 0;
async function worker() {
  while (next < project.chapters.length) {
    const ch = project.chapters[next++];
    const t = Date.now();
    try {
      await translateChapter(project, ch, { call, onProgress: (p) => p.step === "terms" && p.added.length && console.log(`   + ${ch.title.slice(0, 10)}: ${p.added.length} terms`) });
      order.push(ch.title);
      console.log(`✓ ${ch.title.slice(0, 20)} in ${Math.round((Date.now() - t) / 1000)}s`);
    } catch (e) {
      console.log(`✗ ${ch.title.slice(0, 20)}: ${e.kind || ""} ${e.message}`);
      if (e.kind === "quota" || e.kind === "auth") next = project.chapters.length;
    }
  }
}
await Promise.all(Array.from({ length: lanes }, worker));

// Same as the app after a run with the paid-key option: names learned in later chapters may be
// missing from earlier ones, so every flagged chapter gets a fix pass.
const check = (c) => checkTranslation(c.text, c.translation, project.glossary, project.srcLang, project.tgtLang);
const before = project.chapters.filter((c) => c.translation).map((c) => { const r = check(c); return r.missing.length + r.leftovers.length; });
const flagged = project.chapters.filter((c) => c.translation && recheckChapter(project, c)?.ok === false);
console.log(`fix pass: ${flagged.length} chapters flagged (problems per chapter before: ${before.join("/")})`);
for (const c of flagged) {
  try {
    await fixChapter(project, c, { call });
    console.log(`   fixed ${c.title}: ${c.issues.ok ? "clean" : `${c.issues.missing.length + c.issues.leftovers.length} left`}`);
  } catch (e) {
    console.log(`   ✗ fix ${c.title}: ${e.message}`);
  }
}

// Final check of every chapter against the glossary as it stands at the end (terms found later included).
const rows = project.chapters.map((c) => {
  if (!c.translation) return { chapter: c.title.slice(0, 20), translated: false };
  const r = checkTranslation(c.text, c.translation, project.glossary, project.srcLang, project.tgtLang);
  return { chapter: c.title.slice(0, 20), translated: true, missing: r.missing.map((m) => `${m.entry.source}→${m.entry.target}`), leftovers: r.leftovers };
});
const outDir = path.join(root, "corpus", "out", "parallel");
fs.mkdirSync(outDir, { recursive: true });
for (const c of project.chapters) if (c.translation) fs.writeFileSync(path.join(outDir, `${String(project.chapters.indexOf(c) + 1).padStart(2, "0")}.th.txt`), `${c.titleT || c.title}\n\n${c.translation}\n`);
fs.writeFileSync(path.join(outDir, "glossary.json"), JSON.stringify(project.glossary, null, 1));
const summary = { before, lanes, seconds: Math.round((Date.now() - t0) / 1000), calls, peakConcurrent: peak, rateWaits, used, glossary: project.glossary.length, translated: rows.filter((r) => r.translated).length, of: rows.length, rows };
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
