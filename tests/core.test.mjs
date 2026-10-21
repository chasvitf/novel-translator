import test from "node:test";
import assert from "node:assert/strict";
import { splitChapters, chunkText } from "../public/js/lib/split.js";
import { makeEntry, relevantEntries, checkTranslation, parseCSV, toCSV, mergeTerms, countInText } from "../public/js/lib/glossary.js";
import { detectLang } from "../public/js/lib/langs.js";
import { translateChapter, newChapter } from "../public/js/lib/pipeline.js";
import { createCaller, AIError } from "../public/js/lib/providers.js";
import { parseJSON, cleanReply } from "../public/js/lib/prompts.js";

test("splits chapters on headings in many languages", () => {
  const zh = "第一章 開始\n林動醒來。\n\n第二章 修煉\n他修煉。";
  assert.deepEqual(splitChapters(zh).map((c) => c.title), ["第一章 開始", "第二章 修煉"]);
  assert.equal(splitChapters("제1화\n가\n제2화\n나").length, 2);
  assert.equal(splitChapters("Chapter 1\na\n\nChapter 2\nb").length, 2);
  assert.equal(splitChapters("Chương 1\na\nChương 2\nb").length, 2);
  assert.equal(splitChapters("ตอนที่ 1\nก\nตอนที่ 2\nข").length, 2);
  assert.deepEqual(splitChapters("a\n===\nb").map((c) => c.text), ["a", "b"]);
  assert.equal(splitChapters("no headings here").length, 1);
  // Text before the first heading is kept as its own chapter.
  assert.equal(splitChapters("序\n第1章 x\ny")[0].text, "序");
});

test("chunks pack paragraphs and cut overlong ones at sentence ends", () => {
  const text = Array.from({ length: 10 }, (_, i) => "字".repeat(90) + "。" + i).join("\n\n");
  const chunks = chunkText(text, 300);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.length <= 300 + 10));
  const long = chunkText("甲。".repeat(500), 200);
  assert.ok(long.every((c) => c.length <= 200));
  assert.equal(long.join(""), "甲。".repeat(500));
});

test("detects source languages", () => {
  assert.equal(detectLang("吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所で"), "ja");
  assert.equal(detectLang("새침하게 흐린 품이 눈이 올 듯하더니 눈은 아니 오고 얼다가 만 비가"), "ko");
  assert.equal(detectLang("那猴在山中，卻會行走跳躍，食草木，飲澗泉，採山花，覓樹果。一朝天氣炎熱"), "zh");
  assert.equal(detectLang("Bắt đầu từ gà gáy một tiếng, trâu bò lục tục kéo thợ cày đến đoạn đường"), "vi");
  assert.equal(detectLang("To Sherlock Holmes she is always the woman. I have seldom heard him"), "en");
});

const G = () => [
  makeEntry({ source: "美猴王", target: "พญาวานร", type: "title" }),
  makeEntry({ source: "猴王", target: "ราชาวานร", type: "title" }),
  makeEntry({ source: "孫悟空", target: "ซุนหงอคง", type: "person" }),
  makeEntry({ source: "Holmes", target: "โฮมส์", type: "person" }),
];

test("only glossary entries present in the passage are relevant; longer terms shadow shorter", () => {
  const g = G();
  assert.deepEqual(relevantEntries(g, "那美猴王笑了").map((e) => e.source), ["美猴王"]);
  assert.deepEqual(relevantEntries(g, "猴王與美猴王").map((e) => e.source).sort(), ["猴王", "美猴王"].sort());
  assert.equal(countInText(g, "Holmesian Holmes").get(g[3].id), 1);
});

test("check finds missing locked terms and untranslated source text", () => {
  const g = G();
  const r = checkTranslation("孫悟空見了美猴王", "ซุนหงอคงเห็นพญาลิง 美猴", g, "zh", "th");
  assert.deepEqual(r.missing.map((m) => m.entry.source), ["美猴王"]);
  assert.deepEqual(r.leftovers, ["美猴"]);
  assert.ok(checkTranslation("孫悟空", "ซุนหงอคง", g, "zh", "th").ok);
});

test("CSV round trip, with Thai headers and quotes", () => {
  const g = [makeEntry({ source: "天元訣", target: 'คัมภีร์ "ฟ้า", ปฐม', type: "skill", note: "วิชาหลัก" })];
  const back = parseCSV(toCSV(g));
  assert.equal(back[0].target, 'คัมภีร์ "ฟ้า", ปฐม');
  assert.equal(back[0].type, "skill");
  const th = parseCSV("ต้นฉบับ,คำแปล,ประเภท\n林動,หลินต้ง,ตัวละคร\n");
  assert.equal(th[0].type, "person");
  assert.equal(parseCSV("林動\tหลินต้ง\n")[0].target, "หลินต้ง");
});

test("mergeTerms skips known and empty terms", () => {
  const g = G();
  const added = mergeTerms(g, [{ source: "孫悟空", target: "x" }, { source: "花果山", target: "เขาฮวาก่อซัน", type: "place" }, { source: "", target: "y" }], "pending");
  assert.deepEqual(added.map((e) => e.source), ["花果山"]);
  assert.equal(added[0].status, "pending");
});

test("reply parsing", () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(cleanReply("<<<\nสวัสดี\n>>>"), "สวัสดี");
  assert.equal(cleanReply("TRANSLATION:\nสวัสดี"), "สวัสดี");
});

test("pipeline: analyze, translate, check, fix — with a fake model", async () => {
  const project = { srcLang: "zh", tgtLang: "th", genre: "xianxia", polish: false, autoFix: true, autoTerms: "auto", glossary: [], chapters: [] };
  const ch = newChapter("第一回", "孫悟空在花果山。\n\n孫悟空笑了。");
  project.chapters.push(ch);
  const seen = [];
  const call = async ({ system, user, json }) => {
    seen.push(user);
    if (json) return { text: JSON.stringify({ title: "ตอนที่ 1", summary: "ลิงเกิด", terms: [{ source: "孫悟空", target: "ซุนหงอคง", type: "person" }, { source: "不存在", target: "x" }] }) };
    if (user.includes("must be translated as")) return { text: "ซุนหงอคงอยู่ที่เขา\n\nซุนหงอคงหัวเราะ" };
    return { text: "หงอคงอยู่ที่เขา\n\nหงอคงหัวเราะ" }; // misses the locked name on purpose
  };
  await translateChapter(project, ch, { call });
  assert.deepEqual(project.glossary.map((e) => e.source), ["孫悟空"], "invented term is dropped");
  assert.equal(ch.titleT, "ตอนที่ 1");
  assert.equal(ch.status, "done");
  assert.ok(ch.issues.ok);
  assert.equal(ch.translation, "ซุนหงอคงอยู่ที่เขา\n\nซุนหงอคงหัวเราะ");
  assert.ok(seen[1].includes("孫悟空 → ซุนหงอคง"), "glossary goes into the translate prompt");
});

test("caller moves to the next model when the daily quota is gone", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url).match(/models\/([^:]+)/)[1]);
    if (asked.length === 1)
      return new Response(JSON.stringify({ error: { code: 429, message: "You exceeded your current quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }), { status: 200 });
  };
  const exhausted = new Set();
  const switched = [];
  const call = createCaller({ provider: "gemini", key: "k", model: "a", fallbackModels: ["a", "b"], minIntervalMs: 0 }, { exhausted, onSwitch: (f, to) => switched.push([f, to]) });
  const r = await call({ system: "s", user: "u" });
  assert.equal(r.text, "ok");
  assert.equal(r.model, "b");
  assert.deepEqual(asked, ["a", "b"]);
  assert.ok(exhausted.has("gemini/a"));
  await call({ system: "s", user: "u" });
  assert.equal(asked.at(-1), "b", "exhausted model is skipped next time");
  assert.ok(new AIError("quota", "x").kind === "quota");
});

test("a chunk cut off for length is split in half and retried", async () => {
  const project = { srcLang: "en", tgtLang: "th", genre: "modern", polish: false, autoFix: false, autoTerms: "off", glossary: [], chapters: [] };
  const para = "word ".repeat(100).trim();
  const ch = newChapter("c", [para, para, para, para].join("\n\n"));
  ch.summary = "x";
  project.chapters.push(ch);
  const call = async ({ user }) => {
    const passage = user.split("PASSAGE TO TRANSLATE:")[1];
    if (passage.length > 1200) throw Object.assign(new AIError("length", "too long"));
    return { text: "แปลแล้ว" };
  };
  await translateChapter(project, ch, { call });
  assert.equal(ch.translation.split("แปลแล้ว").length - 1, 2, "two halves of two paragraphs each");
});

test("proposed terms: first alternative only, mixed-script renderings rejected", async () => {
  const { cleanProposedTarget } = await import("../public/js/lib/glossary.js");
  assert.equal(cleanProposedTarget("กำนัน / หัวหน้าตำบล", "th"), "กำนัน");
  assert.equal(cleanProposedTarget("ประตูทง소문", "th"), "");
  assert.equal(cleanProposedTarget("“นายคิม”", "th"), "นายคิม");
  assert.equal(cleanProposedTarget("孫悟空", "ja"), "孫悟空");
  const g = [];
  mergeTerms(g, [{ source: "동소문", target: "ประตูทง소문" }, { source: "chánh tổng", target: "กำนัน / หัวหน้าตำบล" }], "locked", "th");
  assert.deepEqual(g.map((e) => [e.source, e.target]), [["chánh tổng", "กำนัน"]]);
});

test("leftover check catches stray characters from any foreign script", () => {
  const r = checkTranslation("揉烏帽子", "หมวกโมมิเอ보ชิ", [], "ja", "th");
  assert.deepEqual(r.leftovers, ["보"]);
  assert.ok(checkTranslation("x", "ข้อความ “ไทย” ล้วน", [], "en", "th").ok);
  assert.ok(checkTranslation("林動", "林動は", [], "zh", "ja").ok, "kanji and kana are fine in Japanese");
});

test("caller tries the next model when one refuses a passage, and keeps the first model preferred", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const asked = [];
  globalThis.fetch = async (url) => {
    const m = String(url).match(/models\/([^:]+)/)[1];
    asked.push(m);
    if (m === "a" && asked.length === 1) return new Response(JSON.stringify({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }), { status: 200 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: `ok-${m}` }] }, finishReason: "STOP" }] }), { status: 200 });
  };
  const call = createCaller({ provider: "gemini", key: "k", model: "a", fallbackModels: ["a", "b"], minIntervalMs: 0 });
  assert.equal((await call({ system: "s", user: "u" })).text, "ok-b");
  assert.equal((await call({ system: "s", user: "u" })).text, "ok-a");
});

test("stray English words in a Thai translation are flagged unless the source has them", () => {
  assert.deepEqual(checkTranslation("見当がつかぬ", "เกิดที่ไหนก็ Coontail ไม่ได้", [], "ja", "th").leftovers, ["Coontail"]);
  assert.ok(checkTranslation("He said OK to Holmes", "เขาบอก OK กับ Holmes", [], "en", "th").ok);
  assert.ok(checkTranslation("x", "Watson", [makeEntry({ source: "华生", target: "Watson" })], "zh", "th").ok);
});

test("letters from any script the target does not use are leaks; asides in proposed terms are dropped", async () => {
  const { cleanProposedTarget } = await import("../public/js/lib/glossary.js");
  assert.deepEqual(checkTranslation("御馬監", "กรมอัศతรสวรรค์", [], "zh", "th").leftovers, ["త"]);
  assert.equal(cleanProposedTarget("กรมอัศతรสวรรค์", "th"), "");
  assert.equal(cleanProposedTarget("ท้าวตั๋วหลัวหลี่ (ท้าวเวสสุวรรณ", "th"), "ท้าวตั๋วหลัวหลี่");
  assert.ok(checkTranslation("x", "Привет мир", [], "en", "ru").ok);
  assert.ok(checkTranslation("x", "Tôi là mèo", [], "ja", "vi").ok);
});

test("a fix is accepted only if it reduces problems and keeps the text's length", async () => {
  const { acceptFix } = await import("../public/js/lib/pipeline.js");
  const two = { missing: [1], leftovers: ["x"] };
  const one = { missing: [], leftovers: ["x"] };
  assert.ok(acceptFix("a".repeat(100), "b".repeat(105), two, one));
  assert.ok(!acceptFix("a".repeat(100), "b".repeat(100), one, one), "no improvement");
  assert.ok(!acceptFix("a".repeat(100), "b".repeat(160), two, one), "grew too much");
});

test("a fix that brings in new garbage is rejected", async () => {
  const { acceptFix } = await import("../public/js/lib/pipeline.js");
  assert.ok(!acceptFix("a".repeat(100), "b".repeat(100), { missing: [1, 2, 3], leftovers: [] }, { missing: [], leftovers: ["را"] }));
});
