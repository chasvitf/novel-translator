import test from "node:test";
import assert from "node:assert/strict";
import { collectCorrections, rememberExamples, relevantExamples, learnFromCorrections } from "../public/js/lib/learn.js";
import { translateChapter, newChapter } from "../public/js/lib/pipeline.js";
import { makeEntry } from "../public/js/lib/glossary.js";

const project = () => ({ srcLang: "zh", tgtLang: "th", genre: "wuxia", polish: false, autoFix: false, autoTerms: "off", glossary: [], chapters: [] });

test("corrections: only paragraphs the person changed, and only once", () => {
  const ch = newChapter("一", "郭靖使出降龍十八掌。\n\n他笑了。");
  ch.chunks = [{ src: ch.text, out: "กัวจิ้งใช้ฝ่ามือมังกร\n\nเขาหัวเราะ" }];
  ch.translation = "กัวจิ้งใช้สิบแปดฝ่ามือพิชิตมังกร\n\nเขาหัวเราะ";
  const { corrections, aligned } = collectCorrections(ch);
  assert.ok(aligned);
  assert.deepEqual(corrections, [{ source: "郭靖使出降龍十八掌。", ai: "กัวจิ้งใช้ฝ่ามือมังกร", fixed: "กัวจิ้งใช้สิบแปดฝ่ามือพิชิตมังกร" }]);
  ch.learnedText = ch.translation;
  assert.equal(collectCorrections(ch).corrections.length, 0, "already learned");
  ch.translation = "กัวจิ้งใช้สิบแปดฝ่ามือพิชิตมังกร";
  assert.equal(collectCorrections(ch).aligned, false, "merged paragraphs cannot be matched");
});

test("learning renames a skill only when the person really changed it, and keeps new rules", async () => {
  const p = project();
  p.glossary.push(makeEntry({ source: "降龍十八掌", target: "ฝ่ามือมังกร", type: "skill" }));
  const corrections = [{ source: "郭靖使出降龍十八掌。", ai: "กัวจิ้งใช้ฝ่ามือมังกร", fixed: "กัวจิ้งใช้สิบแปดฝ่ามือพิชิตมังกร" }];
  const call = async () => ({
    text: JSON.stringify({
      terms: [
        { source: "降龍十八掌", target: "สิบแปดฝ่ามือพิชิตมังกร", type: "skill" },
        { source: "郭靖", target: "กัวจิ้ง", type: "person" }, // unchanged by the person: not a lesson
        { source: "黃蓉", target: "อึ้งย้ง", type: "person" }, // not in the source: invented
      ],
      rules: ["แปลชื่อวิชาให้ครบทุกส่วนของชื่อ"],
    }),
  });
  const r = await learnFromCorrections(p, corrections, call);
  assert.deepEqual(r.renamed.map((x) => [x.from, x.to]), [["ฝ่ามือมังกร", "สิบแปดฝ่ามือพิชิตมังกร"]]);
  assert.equal(r.added.length, 0);
  assert.equal(p.glossary[0].target, "สิบแปดฝ่ามือพิชิตมังกร");
  assert.deepEqual(p.memory.rules.map((x) => x.text), ["แปลชื่อวิชาให้ครบทุกส่วนของชื่อ"]);
  await learnFromCorrections(p, corrections, call);
  assert.equal(p.memory.rules.length, 1, "a rule is kept once");
});

test("learned rules and similar corrections go into the translate prompt", async () => {
  const p = project();
  rememberExamples(p, [{ source: "郭靖使出降龍十八掌。", ai: "กัวจิ้งใช้ฝ่ามือมังกร", fixed: "กัวจิ้งใช้สิบแปดฝ่ามือพิชิตมังกร" }, { source: "天氣很好。", ai: "a", fixed: "b" }], "c1");
  p.memory.rules.push({ id: "r1", text: "ห้ามตัดส่วนใดของชื่อวิชา" });
  assert.deepEqual(relevantExamples(p, "郭靖又使出降龍十八掌。").map((e) => e.source), ["郭靖使出降龍十八掌。"]);
  const ch = newChapter("二", "郭靖又使出降龍十八掌。");
  p.chapters.push(ch);
  const seen = [];
  await translateChapter(p, ch, { call: async ({ system, user }) => (seen.push({ system, user }), { text: "กัวจิ้งใช้สิบแปดฝ่ามือพิชิตมังกรอีกครั้ง" }) });
  assert.ok(seen[0].system.includes("ห้ามตัดส่วนใดของชื่อวิชา"));
  assert.ok(seen[0].user.includes("Translator's correction (follow this): กัวจิ้งใช้สิบแปดฝ่ามือพิชิตมังกร"));
  assert.ok(!seen[0].user.includes("天氣很好"), "unrelated corrections stay out");
});

test("numbered replies are put back one paragraph per source paragraph", async () => {
  const { alignedReply, numberParas } = await import("../public/js/lib/prompts.js");
  const src = "甲。\n\n乙。\n\n丙。";
  assert.equal(numberParas(src), "[1] 甲。\n\n[2] 乙。\n\n[3] 丙。");
  // paragraph 2 split in two, a stray blank number: still three paragraphs in order
  assert.equal(alignedReply("[1] หนึ่ง\n\n[2] สอง\nสองต่อ\n\n[3] สาม", src, "th"), "หนึ่ง\n\nสอง สองต่อ\n\nสาม");
  // a missing number leaves that paragraph out, so the structure check sees it as missing
  assert.equal(alignedReply("[1] หนึ่ง\n\n[3] สาม", src, "th"), "หนึ่ง\n\nสาม");
  // no numbers at all: used as it is
  assert.equal(alignedReply("หนึ่ง\n\nสอง\n\nสาม", src, "th"), "หนึ่ง\n\nสอง\n\nสาม");
});

test("a translation reply that drops a numbered paragraph is repaired", async () => {
  const p = project();
  p.autoFix = true;
  const ch = newChapter("一", "他走進洞裡，看見一隻猴子坐在那裡。\n\n「你是誰？」猴子問。\n\n天色漸漸暗了下來，風也大了。");
  p.chapters.push(ch);
  let n = 0;
  const call = async () => (++n === 1
    ? { text: "[1] เขาเดินเข้าไปในถ้ำ เห็นลิงตัวหนึ่งนั่งอยู่ตรงนั้น\n\n[2] “เจ้าเป็นใคร” ลิงถาม" }
    : { text: "[1] เขาเดินเข้าไปในถ้ำ เห็นลิงตัวหนึ่งนั่งอยู่ตรงนั้น\n\n[2] “เจ้าเป็นใคร” ลิงถาม\n\n[3] ฟ้าค่อยๆ มืดลง ลมก็แรงขึ้น" });
  await translateChapter(p, ch, { call });
  assert.equal(ch.translation.split("\n\n").length, 3);
  assert.ok(!/\[\d\]/.test(ch.translation), "no numbers left in the text");
  assert.ok(ch.issues.ok);
});
