// Translate one chapter of a saved project again with the current pipeline.
// Usage: node scripts/retranslate.mjs <project.json> <chapter-index> [model]
import fs from "node:fs";
import path from "node:path";
import { createCaller, PROVIDERS } from "../public/js/lib/providers.js";
import { translateChapter } from "../public/js/lib/pipeline.js";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const env = Object.fromEntries(fs.readFileSync(path.join(root, ".env"), "utf8").split("\n").map((l) => l.split("=")).filter((x) => x[1]).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
const [file, idx, model = "gemini-3.5-flash-lite"] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, "utf8"));
const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const exFile = path.join(root, "corpus", "out", `exhausted-${day}.json`);
const exhausted = new Set(fs.existsSync(exFile) ? JSON.parse(fs.readFileSync(exFile, "utf8")) : []);
const call = createCaller({ provider: "gemini", model, key: env.GEMINI_API_KEY, fallbackModels: PROVIDERS.gemini.models }, {
  exhausted, onSwitch: (a, b, why) => console.log(`⇄ ${a} → ${b} (${why.slice(0, 50)})`),
});
const ch = p.chapters[Number(idx)];
await translateChapter(p, ch, { call, onProgress: (e) => e.step === "fix" && console.log(`fix ${e.chunk + 1}: ${[...e.issues.missing.map((m) => m.entry.source), ...e.issues.leftovers].join(", ")}`) });
console.log(ch.title, ch.issues.ok ? "✓ clean" : JSON.stringify({ missing: ch.issues.missing.map((m) => m.entry.source), leftovers: ch.issues.leftovers }), ch.models);
fs.writeFileSync(file, JSON.stringify(p));
fs.writeFileSync(exFile, JSON.stringify([...exhausted]));
