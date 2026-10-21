// Copy translated test projects from corpus/out into public/samples as ready-made demo projects.
// Usage: node scripts/build_samples.mjs   (each book names the run it ships)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(root, "corpus", "out");
const BOOKS = {
  xiyouji: {
    from: "gemini-gemini-flash-lite-latest/xiyouji.project.json",
    titlesT: ["ตอนที่ 1 รากวิญญาณถือกำเนิด บำเพ็ญจิตจนบรรลุมรรคา", "ตอนที่ 2 รู้แจ้งสัจธรรมอันลึกซึ้ง สยบมารร้ายคืนสู่ธรรมญาณเดิม", "ตอนที่ 3 สี่สมุทรพันภูผาล้วนสยบ ยมโลกลบชื่อสิ้น", "ตอนที่ 4 ได้เป็นเซียนคอกม้าใจไม่พอ จารึกนามมหาเทพเสมอฟ้ายังไม่สงบ", "ตอนที่ 5 ป่วนงานท้อสวรรค์ มหาเทพขโมยโอสถ กบฏวังสวรรค์"],
    name: "西遊記 ไซอิ๋ว (ตัวอย่าง)", credit: "吳承恩《西遊記》第一回–第五回 · Wikisource · public domain" },
  rashomon: { from: "gemini-gemini-3.8-flash/rashomon.project.json", titlesT: ["ราโชมอน"], titles: ["羅生門"], name: "羅生門 ราโชมอน (ตัวอย่าง)", credit: "芥川龍之介「羅生門」· 青空文庫 Aozora Bunko · public domain" },
  unsu: { from: "gemini-gemini-3.1-flash-lite/unsu.project.json", titlesT: ["วันโชคดี"], titles: ["운수 좋은 날"], name: "운수 좋은 날 วันโชคดี (ตัวอย่าง)", credit: "현진건 「운수 좋은 날」(1924) · Wikisource · public domain" },
  holmes: { from: "gemini-gemini-3.8-flash/holmes.project.json", titlesT: ["เรื่องอื้อฉาวในโบฮีเมีย ภาคที่ 1"], titles: ["A Scandal in Bohemia, Part I"], name: "A Scandal in Bohemia (ตัวอย่าง)", credit: "Arthur Conan Doyle, The Adventures of Sherlock Holmes · Project Gutenberg · public domain" },
};
for (const [id, meta] of Object.entries(BOOKS)) {
  const file = path.join(out, meta.from);
  if (!fs.existsSync(file)) {
    console.log(`- ${id}: ${meta.from} not found`);
    continue;
  }
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  p.name = meta.name;
  p.credit = meta.credit;
  p.chapters.forEach((c, i) => {
    if (meta.titles?.[i]) c.title = meta.titles[i];
    if (meta.titlesT?.[i]) c.titleT = meta.titlesT[i];
    for (const k of c.chunks || []) delete k.draft;
  });
  delete p.id;
  fs.writeFileSync(path.join(root, "public", "samples", `${id}.json`), JSON.stringify(p));
  console.log(`✓ ${id} ← ${path.relative(root, file)} (${p.chapters.length} ch, ${p.glossary.length} terms)`);
}
