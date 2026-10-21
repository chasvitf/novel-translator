// Translate the public-domain test chapters with the real pipeline and report glossary consistency.
// Usage: node scripts/run_corpus.mjs [provider] [model] [files...]   (keys come from .env)
import fs from "node:fs";
import path from "node:path";
import { createCaller, PROVIDERS } from "../public/js/lib/providers.js";
import { translateChapter, newChapter } from "../public/js/lib/pipeline.js";
import { detectLang, GENRES } from "../public/js/lib/langs.js";
import { checkTranslation } from "../public/js/lib/glossary.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const m = /^(\w+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2];
}
const [provider = "gemini", model = "gemini-3.5-flash", ...only] = process.argv.slice(2);
const key = { gemini: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY, openrouter: process.env.OPENROUTER_API_KEY }[provider] || "";
const outDir = path.join(root, "corpus", "out", `${provider}-${model.replace(/[/:]/g, "_")}`);
fs.mkdirSync(outDir, { recursive: true });

// Books: chapters of one book share a project (and so a glossary) to test consistency across chapters.
const books = {
  xiyouji: { genre: "xianxia", nameStyle: "hokkien", files: ["zh-xiyouji-01.txt", "zh-xiyouji-02.txt"] },
  // Chapters 3-5 continue the demo sample (its glossary and summaries) to test consistency over many chapters.
  xiyouji35: { continueFrom: "public/samples/xiyouji.json", files: ["zh-xiyouji-03.txt", "zh-xiyouji-04.txt", "zh-xiyouji-05.txt"] },
  shuihu: { genre: "wuxia", nameStyle: "mandarin", files: ["zh-shuihu-02.txt"] },
  rashomon: { genre: "classic", files: ["ja-rashomon.txt"] },
  neko: { genre: "classic", files: ["ja-neko-01.txt"] },
  unsu: { genre: "classic", nameStyle: "thai", files: ["ko-unsu.txt"] },
  holmes: { genre: "mystery", files: ["en-holmes-scandal.txt"] },
  tatden: { genre: "classic", files: ["vi-tatden-01.txt"] },
};

let calls = 0, tokens = 0;
const exhaustedFile = path.join(root, "corpus", "out", `exhausted-${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.json`);
const exhausted = new Set(fs.existsSync(exhaustedFile) ? JSON.parse(fs.readFileSync(exhaustedFile, "utf8")) : []);
const base = createCaller({ provider, model, key, fallbackModels: PROVIDERS[provider].models }, {
  exhausted,
  onWait: (ms, why) => console.log(`   … wait ${Math.round(ms / 1000)}s (${why.slice(0, 80)})`),
  onSwitch: (from, to, why) => { console.log(`   ⇄ ${from} → ${to} (${why.slice(0, 60)})`); fs.writeFileSync(exhaustedFile, JSON.stringify([...exhausted])); },
});
const used = {};
const call = async (req) => { calls++; const r = await base(req); tokens += r.usage; used[r.model] = (used[r.model] || 0) + 1; return r; };

const report = [];
const startGlossary = {};
for (const [name, book] of Object.entries(books)) {
  if (only.length && !only.some((o) => name.includes(o) || book.files.some((f) => f.includes(o)))) continue;
  const first = fs.readFileSync(path.join(root, "corpus", book.files[0]), "utf8");
  const project = { name, srcLang: detectLang(first), tgtLang: "th", genre: book.genre, nameStyle: book.nameStyle, custom: "", polish: process.env.POLISH === "1", autoFix: true, autoTerms: "auto", glossary: [], chapters: [] };
  project.chapters = book.files.map((f) => newChapter(f.replace(".txt", ""), fs.readFileSync(path.join(root, "corpus", f), "utf8")));
  let todo = project.chapters;
  if (book.continueFrom) {
    const prev = JSON.parse(fs.readFileSync(path.join(root, book.continueFrom), "utf8"));
    Object.assign(project, { genre: prev.genre, nameStyle: prev.nameStyle, glossary: prev.glossary, chapters: [...prev.chapters, ...project.chapters] });
  }
  for (const ch of todo) {
    const t0 = Date.now();
    console.log(`▶ ${ch.title} (${project.srcLang}, ${ch.text.length} chars)`);
    await translateChapter(project, ch, { call, onProgress: (p) => p.step === "terms" ? console.log(`   + ${p.added.length} terms`) : p.step === "warn" ? console.log("   ! " + p.message) : p.step === "fix" ? console.log(`   fix chunk ${p.chunk + 1}: ${[...p.issues.missing.map((m) => m.entry.source + "→" + m.entry.target), ...p.issues.leftovers].join(", ")}`) : null });
    const final = checkTranslation(ch.text, ch.translation, project.glossary, project.srcLang, project.tgtLang);
    const row = { chapter: ch.title, lang: project.srcLang, chars: ch.text.length, chunks: ch.chunks.length, seconds: Math.round((Date.now() - t0) / 1000), glossary: project.glossary.length, missing: final.missing.map((m) => `${m.entry.source}→${m.entry.target}`), leftovers: final.leftovers, draftMisses: ch.chunks.reduce((n, c) => n + checkTranslation(c.src, c.draft, project.glossary, project.srcLang, "th").missing.length, 0) };
    report.push(row);
    console.log(`   ✓ ${row.seconds}s, ${row.chunks} chunks, glossary ${row.glossary}, missing ${row.missing.length}, leftovers ${row.leftovers.length}, draft misses ${row.draftMisses}`);
    fs.writeFileSync(path.join(outDir, `${ch.title}.th.txt`), `${ch.titleT || ch.title}\n\n${ch.translation}\n`);
  }
  fs.writeFileSync(path.join(outDir, `${name}.project.json`), JSON.stringify(project));
  fs.writeFileSync(path.join(outDir, `${name}.glossary.json`), JSON.stringify(project.glossary, null, 1));
  fs.writeFileSync(path.join(outDir, `${name}.summaries.json`), JSON.stringify(project.chapters.map((c) => ({ title: c.titleT, summary: c.summary })), null, 1));
}
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ provider, model, calls, tokens, used, report }, null, 1));
console.log(`\n${calls} calls, ${tokens} tokens, by model ${JSON.stringify(used)} → ${outDir}`);
