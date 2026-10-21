// Re-run the glossary/script check on every saved test run (no AI calls).
import fs from "node:fs";
import path from "node:path";
import { checkTranslation } from "../public/js/lib/glossary.js";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dirs = [path.join(root, "public", "samples"), ...fs.readdirSync(path.join(root, "corpus", "out")).map((d) => path.join(root, "corpus", "out", d)).filter((d) => fs.statSync(d).isDirectory())];
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !/glossary|summaries|report/.test(f))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!p.chapters) continue;
    for (const c of p.chapters.filter((c) => c.translation)) {
      const r = checkTranslation(c.text, c.translation, p.glossary, p.srcLang, p.tgtLang);
      console.log(`${r.ok ? "✓" : "✗"} ${path.relative(root, dir)}/${f} ${c.title.slice(0, 20)} missing=${r.missing.map((m) => m.entry.source).join(",")} leftovers=${r.leftovers.join(",")}`);
    }
  }
}
