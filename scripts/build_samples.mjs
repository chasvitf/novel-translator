// Copy translated test projects from corpus/out into public/samples as ready-made demo projects.
// Usage: node scripts/build_samples.mjs   (picks the newest run of each book)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(root, "corpus", "out");
const BOOKS = {
  xiyouji: { name: "西遊記 ไซอิ๋ว (ตัวอย่าง)", credit: "吳承恩《西遊記》第一回–第二回 · Wikisource · public domain" },
  rashomon: { titles: ["羅生門"], name: "羅生門 ราโชมอน (ตัวอย่าง)", credit: "芥川龍之介「羅生門」· 青空文庫 Aozora Bunko · public domain" },
  unsu: { titles: ["운수 좋은 날"], name: "운수 좋은 날 วันโชคดี (ตัวอย่าง)", credit: "현진건 「운수 좋은 날」(1924) · Wikisource · public domain" },
  holmes: { titles: ["A Scandal in Bohemia, Part I"], name: "A Scandal in Bohemia (ตัวอย่าง)", credit: "Arthur Conan Doyle, The Adventures of Sherlock Holmes · Project Gutenberg · public domain" },
};
for (const [id, meta] of Object.entries(BOOKS)) {
  const runs = fs.readdirSync(out).map((d) => path.join(out, d, `${id}.project.json`)).filter((f) => fs.existsSync(f));
  if (!runs.length) {
    console.log(`- ${id}: no run yet`);
    continue;
  }
  const file = runs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  p.name = meta.name;
  p.credit = meta.credit;
  p.chapters.forEach((c, i) => {
    if (meta.titles?.[i]) c.title = meta.titles[i];
    for (const k of c.chunks || []) delete k.draft;
  });
  delete p.id;
  fs.writeFileSync(path.join(root, "public", "samples", `${id}.json`), JSON.stringify(p));
  console.log(`✓ ${id} ← ${path.relative(root, file)} (${p.chapters.length} ch, ${p.glossary.length} terms)`);
}
