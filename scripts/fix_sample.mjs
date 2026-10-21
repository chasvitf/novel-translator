// Re-run the glossary/script check on a demo sample and let the AI fix what it finds (same as "ให้ AI แก้").
// Usage: node scripts/fix_sample.mjs <sample-id> [model]
import fs from "node:fs";
import path from "node:path";
import { createCaller, PROVIDERS } from "../public/js/lib/providers.js";
import { fixChapter } from "../public/js/lib/pipeline.js";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const env = Object.fromEntries(fs.readFileSync(path.join(root, ".env"), "utf8").split("\n").map((l) => l.split("=")).filter((x) => x[1]).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
const [id, model = "gemini-3.1-flash-lite"] = process.argv.slice(2);
const file = path.join(root, "public", "samples", `${id}.json`);
const p = JSON.parse(fs.readFileSync(file, "utf8"));
const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const exFile = path.join(root, "corpus", "out", `exhausted-${day}.json`);
const exhausted = new Set(fs.existsSync(exFile) ? JSON.parse(fs.readFileSync(exFile, "utf8")) : []);
const call = createCaller({ provider: "gemini", model, key: env.GEMINI_API_KEY, fallbackModels: PROVIDERS.gemini.models }, { exhausted });
for (const c of p.chapters) {
  const r = await fixChapter(p, c, { call });
  console.log(c.title, r.ok ? "✓ clean" : `still: ${JSON.stringify({ missing: r.missing.map((m) => m.entry.source), leftovers: r.leftovers })}`);
}
fs.writeFileSync(file, JSON.stringify(p));
fs.writeFileSync(exFile, JSON.stringify([...exhausted]));
