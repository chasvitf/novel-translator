// Long jobs, provider failures and the quality checks that run after translation. Every model here is
// a fake: no test spends API quota.
import test from "node:test";
import assert from "node:assert/strict";
import { translateChapter, newChapter, runChapters, resetStuck, acceptFix } from "../public/js/lib/pipeline.js";
import { createCaller, AIError, withBackup } from "../public/js/lib/providers.js";
import { checkTranslation, makeEntry, issueCount } from "../public/js/lib/glossary.js";

const project = (extra = {}) => ({ srcLang: "zh", tgtLang: "th", genre: "xianxia", nameStyle: "", custom: "", polish: false, autoFix: true, autoTerms: "off", glossary: [], chapters: [], ...extra });

// A fake translator: one Thai paragraph per source paragraph, so the structure checks pass.
const passageOf = (user) => /PASSAGE TO TRANSLATE:\n<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? "";
const translateAll = (user) => passageOf(user).split(/\n\n/).map((p) => "แปล".repeat(Math.max(1, Math.round(p.length / 2)))).join("\n\n");

const gemini = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 10 } }), { status: 200 });
function fakeFetch(t, handler) {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url).match(/models\/([^:]+)/)?.[1]);
    return handler(seen.length, init);
  };
  return seen;
}
const fast = { provider: "gemini", key: "k", model: "a", minIntervalMs: 0 };

// ---------- provider failures ----------

// Hangs until its request is aborted, like a connection that stopped answering.
const hang = (init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

test("a request that never answers times out and is retried", { timeout: 3000 }, async (t) => {
  const seen = fakeFetch(t, (n, init) => (n === 1 ? hang(init) : gemini("ok")));
  const call = createCaller({ ...fast, timeoutMs: 30 }, { retryBaseMs: 1 });
  assert.equal((await call({ system: "s", user: "u" })).text, "ok");
  assert.equal(seen.length, 2);
});

test("stopping the run during a request is a stop, not a timeout to retry", async (t) => {
  fakeFetch(t, (n, init) => hang(init));
  const stop = new AbortController();
  const call = createCaller({ ...fast, timeoutMs: 5000 }, { retryBaseMs: 1 });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(call({ system: "s", user: "u", signal: stop.signal }), { name: "AbortError" });
});

test("rate limits are retried a bounded number of times", async (t) => {
  const seen = fakeFetch(t, () => new Response(JSON.stringify({ error: { code: 429, message: "Resource exhausted, per minute" } }), { status: 429 }));
  const call = createCaller(fast, { retryBaseMs: 1, maxAttempts: 4 });
  await assert.rejects(call({ system: "s", user: "u" }), { kind: "rate" });
  assert.equal(seen.length, 4);
});

test("an invalid request is not retried", async (t) => {
  const seen = fakeFetch(t, () => new Response(JSON.stringify({ error: { code: 400, message: "Invalid argument" } }), { status: 400 }));
  await assert.rejects(createCaller({ ...fast, fallbackModels: ["b"] }, { retryBaseMs: 1 })({ system: "s", user: "u" }), { kind: "bad" });
  assert.equal(seen.length, 1);
});

test("when every model's daily quota is gone the caller gives up instead of looping", async (t) => {
  const seen = fakeFetch(t, () => new Response(JSON.stringify({ error: { code: 429, message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), { status: 429 }));
  const exhausted = new Set();
  await assert.rejects(createCaller({ ...fast, fallbackModels: ["b"] }, { exhausted, retryBaseMs: 1 })({ system: "s", user: "u" }), { kind: "quota" });
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual([...exhausted], ["gemini/a", "gemini/b"]);
});

test("an empty or malformed provider reply is reported as a bad reply", async (t) => {
  fakeFetch(t, () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
  await assert.rejects(createCaller(fast, { retryBaseMs: 1 })({ system: "s", user: "u" }), { kind: "bad" });
});

// ---------- structure checks ----------

const SRC = "第一段，他走進了山洞，看見一隻猴子。\n\n「你是誰？」猴子問道。\n\n第三段，天色漸漸暗了下來，風也大了。";

test("a dropped paragraph is flagged", () => {
  const r = checkTranslation(SRC, "เขาเดินเข้าถ้ำแล้วเห็นลิงตัวหนึ่ง\n\n“เจ้าเป็นใคร” ลิงถาม", [], "zh", "th");
  assert.equal(r.ok, false);
  assert.equal(r.structure[0].kind, "paragraphs");
});

test("a paragraph translated far shorter than the rest is flagged as a possible omission", () => {
  const r = checkTranslation(SRC, "เขาเดินเข้าไปในถ้ำและได้เห็นลิงตัวหนึ่งกำลังนั่งอยู่\n\n“เจ้าเป็นใคร” ลิงตัวนั้นถามขึ้นมา\n\nมืด", [], "zh", "th");
  assert.deepEqual(r.structure.map((s) => s.kind), ["short"]);
  assert.ok(r.structure[0].src.startsWith("第三段"));
});

test("dialogue that lost its quotation marks is flagged", () => {
  const r = checkTranslation(SRC, "เขาเดินเข้าไปในถ้ำและได้เห็นลิงตัวหนึ่ง\n\nเจ้าเป็นใคร ลิงตัวนั้นถามขึ้นมา\n\nฟ้าเริ่มมืดลงทีละน้อย และลมก็แรงขึ้น", [], "zh", "th");
  assert.deepEqual(r.structure.map((s) => s.kind), ["dialogue"]);
});

test("a faithful translation passes even though Thai is much longer than Chinese", () => {
  const r = checkTranslation(SRC, "เขาเดินเข้าไปในถ้ำและได้เห็นลิงตัวหนึ่งกำลังนั่งอยู่บนก้อนหิน\n\n“เจ้าเป็นใคร” ลิงตัวนั้นถามขึ้นมา\n\nฟ้าเริ่มมืดลงทีละน้อย และลมก็พัดแรงขึ้นเรื่อยๆ", [], "zh", "th");
  assert.ok(r.ok, JSON.stringify(r.structure));
  assert.equal(issueCount(r), 0);
});

test("a fix that merges away a paragraph is rejected even if it fixes the name", () => {
  const before = { missing: [1], leftovers: [], structure: [] };
  const after = { missing: [], leftovers: [], structure: [{ kind: "paragraphs" }] };
  assert.ok(!acceptFix("a".repeat(100), "b".repeat(95), before, after));
});

test("wrong terminology is still caught alongside the structure checks", () => {
  const g = [makeEntry({ source: "猴子", target: "วานร" })];
  const r = checkTranslation("猴子笑了。", "ลิงหัวเราะ", g, "zh", "th");
  assert.deepEqual(r.missing.map((m) => m.entry.source), ["猴子"]);
  assert.equal(issueCount(r), 1);
});

// ---------- targeted repair ----------

test("a chunk that came back with a paragraph missing is translated again and the complete one kept", async () => {
  const p = project();
  const ch = newChapter("一", SRC);
  p.chapters.push(ch);
  let n = 0;
  const call = async ({ user }) => {
    n++;
    if (n === 1) return { text: "เขาเดินเข้าถ้ำแล้วเห็นลิงตัวหนึ่งกำลังนั่งอยู่\n\n“เจ้าเป็นใคร” ลิงตัวนั้นถาม" };
    return { text: translateAll(user).replace(/^(.*)\n\n(.*)\n\n/, "$1\n\n“$2”\n\n") };
  };
  await translateChapter(p, ch, { call });
  assert.equal(ch.translation.split("\n\n").length, 3);
  assert.ok(ch.issues.ok, JSON.stringify(ch.issues.structure));
});

test("a single short paragraph is re-translated on its own, not the whole chunk", async () => {
  const p = project();
  const ch = newChapter("一", SRC);
  p.chapters.push(ch);
  const sent = [];
  const call = async ({ user }) => {
    sent.push(passageOf(user));
    if (sent.length === 1) return { text: "เขาเดินเข้าไปในถ้ำและได้เห็นลิงตัวหนึ่งกำลังนั่งอยู่\n\n“เจ้าเป็นใคร” ลิงตัวนั้นถามขึ้นมา\n\nมืด" };
    return { text: "ฟ้าเริ่มมืดลงทีละน้อย และลมก็พัดแรงขึ้นเรื่อยๆ" };
  };
  await translateChapter(p, ch, { call });
  assert.equal(sent.length, 2);
  assert.equal(sent[1], "第三段，天色漸漸暗了下來，風也大了。", "only the short paragraph is sent again");
  assert.ok(ch.translation.endsWith("ลมก็พัดแรงขึ้นเรื่อยๆ"));
  assert.ok(ch.issues.ok);
});

// ---------- independent review ----------

const REVIEW_SRC = "王五拿起劍，對李四說：「明天我們去京城。」\n\n李四點了點頭。";
const GOOD_OUT = "หวังอู่หยิบกระบี่ขึ้นมา แล้วพูดกับหลี่ซื่อว่า “พรุ่งนี้พวกเราจะไปเมืองหลวง”\n\nหลี่ซื่อพยักหน้า";
const WRONG_OUT = "หวังอู่หยิบกระบี่ขึ้นมา แล้วพูดกับหลี่ซื่อว่า “เมื่อวานพวกเราไปเมืองหลวงมา”\n\nหลี่ซื่อพยักหน้า";

function reviewer(answers) {
  const asked = [];
  const call = async (req) => {
    asked.push(req);
    const a = answers.shift();
    return { text: JSON.stringify(typeof a === "function" ? a(req) : a), model: "reviewer" };
  };
  return { call, asked };
}

test("a reviewed meaning error is corrected in that paragraph only and checked again", async () => {
  const p = project({ review: true, autoFix: false });
  const ch = newChapter("一", REVIEW_SRC);
  p.chapters.push(ch);
  const tr = [];
  const call = async ({ user }) => {
    tr.push(user);
    if (tr.length === 1) return { text: WRONG_OUT, model: "translator" };
    return { text: "หวังอู่หยิบกระบี่ขึ้นมา แล้วพูดกับหลี่ซื่อว่า “พรุ่งนี้พวกเราจะไปเมืองหลวง”", model: "translator" };
  };
  const rv = reviewer([
    { issues: [{ paragraph: 1, type: "meaning", source: "明天我們去京城", translation: "เมื่อวานพวกเราไปเมืองหลวงมา", problem: "明天 means tomorrow, the translation says yesterday" }] },
    { issues: [] },
  ]);
  await translateChapter(p, ch, { call, reviewCall: rv.call });
  assert.equal(ch.translation, GOOD_OUT);
  assert.equal(ch.review.fixed.length, 1);
  assert.equal(ch.review.unresolved.length, 0);
  assert.equal(ch.review.model, "reviewer");
  assert.ok(!tr[1].includes("李四點了點頭"), "the correction request carries only the faulty paragraph");
  assert.ok(rv.asked[1].user.includes("พรุ่งนี้"), "the corrected paragraph is reviewed again");
});

test("reviewer findings that quote text not in the passage are discarded", async () => {
  const p = project({ review: true, autoFix: false });
  const ch = newChapter("一", REVIEW_SRC);
  p.chapters.push(ch);
  const rv = reviewer([{ issues: [{ paragraph: 1, type: "meaning", source: "趙六", translation: "หวังอู่", problem: "invented: 趙六 is not in the source" }, { paragraph: 9, type: "omission", source: "李四", translation: "หลี่ซื่อ", problem: "x" }, "garbage"] }]);
  await translateChapter(p, ch, { call: async () => ({ text: GOOD_OUT }), reviewCall: rv.call });
  assert.equal(ch.translation, GOOD_OUT);
  assert.equal(ch.review.found.length, 0);
  assert.equal(rv.asked.length, 1);
});

test("a problem the correction cannot solve is left for a human after the configured attempts", async () => {
  const p = project({ review: true, autoFix: false, maxCorrections: 1 });
  const ch = newChapter("一", REVIEW_SRC);
  p.chapters.push(ch);
  const issue = { paragraph: 1, type: "meaning", source: "明天我們去京城", translation: "เมื่อวานพวกเราไปเมืองหลวงมา", problem: "tomorrow, not yesterday" };
  let calls = 0;
  const call = async () => (calls++, { text: calls === 1 ? WRONG_OUT : "หวังอู่หยิบกระบี่ขึ้นมา แล้วพูดกับหลี่ซื่อว่า “เมื่อวานพวกเราไปเมืองหลวงมา”" });
  const rv = reviewer([{ issues: [issue] }, { issues: [issue] }]);
  await translateChapter(p, ch, { call, reviewCall: rv.call });
  assert.equal(calls, 2, "one correction attempt");
  assert.equal(ch.review.unresolved.length, 1);
  assert.equal(ch.review.unresolved[0].problem, "tomorrow, not yesterday");
  assert.ok(issueCount(ch.issues, ch.review) >= 1, "the chapter is marked for checking");
});

test("a reviewer that fails leaves the translation in place and says it was not reviewed", async () => {
  const p = project({ review: true, autoFix: false });
  const ch = newChapter("一", REVIEW_SRC);
  p.chapters.push(ch);
  await translateChapter(p, ch, { call: async () => ({ text: GOOD_OUT }), reviewCall: async () => { throw new AIError("bad", "nope"); } });
  assert.equal(ch.status, "done");
  assert.equal(ch.translation, GOOD_OUT);
  assert.match(ch.review.error, /nope/);
});

// ---------- whole jobs ----------

const book = (n) => {
  const p = project({ autoFix: false });
  for (let i = 0; i < n; i++) p.chapters.push(newChapter(`第${i + 1}章`, `第${i + 1}章的內容。\n\n他說了一句話。`, `c${i}`));
  return p;
};

test("a 1,000-chapter job finishes every chapter exactly once within the lane limit", async () => {
  const p = book(1000);
  const perChapter = new Map();
  let inflight = 0, peak = 0;
  const call = async ({ user }) => {
    const id = /第(\d+)章/.exec(passageOf(user))[1];
    perChapter.set(id, (perChapter.get(id) || 0) + 1);
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setImmediate(r));
    inflight--;
    return { text: translateAll(user), usage: 7 };
  };
  const saved = [];
  const r = await runChapters(p, p.chapters, { call, lanes: 8, onChapter: (c) => saved.push(c.id) });
  assert.equal(r.done, 1000);
  assert.equal(p.chapters.filter((c) => c.status === "done").length, 1000);
  assert.ok([...perChapter.values()].every((n) => n === 1), "no chapter is translated twice");
  assert.equal(new Set(saved).size, 1000, "every finished chapter is handed over to be saved");
  assert.ok(peak <= 8 && peak > 1, `peak concurrency ${peak}`);
  assert.equal(p.chapters[0].stats.calls, 1);
  assert.equal(p.chapters[0].stats.tokens, 7);
});

test("quota running out stops the job, keeps finished chapters, and a second run resumes the rest", async () => {
  const p = book(30);
  let calls = 0;
  const translated = [];
  const call = async ({ user }) => {
    if (++calls > 10) throw new AIError("quota", "all gone");
    translated.push(/第(\d+)章/.exec(passageOf(user))[1]);
    return { text: translateAll(user) };
  };
  const first = await runChapters(p, p.chapters, { call, lanes: 3 });
  assert.equal(first.stopped, "quota");
  assert.equal(first.done, 10);
  assert.equal(p.chapters.filter((c) => c.status === "done").length, 10);
  assert.ok(p.chapters.every((c) => c.status !== "working"));
  calls = -1000; // quota is back
  const second = await runChapters(p, p.chapters.filter((c) => !c.translation), { call, lanes: 3 });
  assert.equal(second.done, 20);
  assert.equal(new Set(translated).size, translated.length, "finished chapters are not translated again");
  assert.equal(p.chapters.filter((c) => c.status === "done").length, 30);
});

test("one chapter failing does not lose or stop the others", async () => {
  const p = book(5);
  const call = async ({ user }) => {
    if (passageOf(user).includes("第3章")) throw new AIError("bad", "400: invalid");
    return { text: translateAll(user) };
  };
  const r = await runChapters(p, p.chapters, { call, lanes: 2 });
  assert.equal(r.done, 4);
  assert.equal(r.failed, 1);
  assert.equal(p.chapters[2].status, "error");
  assert.match(p.chapters[2].error, /invalid/);
});

test("cancelling keeps finished chapters, returns the rest to not-translated, and the job can resume", async () => {
  const p = book(20);
  const stop = new AbortController();
  let n = 0;
  const call = async ({ user, signal }) => {
    if (++n === 6) stop.abort();
    await new Promise((r) => setImmediate(r));
    if (signal?.aborted) throw new DOMException("หยุดแล้ว", "AbortError");
    return { text: translateAll(user) };
  };
  const r = await runChapters(p, p.chapters, { call, lanes: 2, signal: stop.signal });
  assert.equal(r.stopped, "cancelled");
  const done = p.chapters.filter((c) => c.status === "done").length;
  assert.ok(done >= 4 && done < 20, `${done} done before the stop`);
  assert.ok(p.chapters.every((c) => c.status === "done" || c.status === "new"));
  const again = await runChapters(p, p.chapters.filter((c) => !c.translation), { call: async ({ user }) => ({ text: translateAll(user) }), lanes: 2 });
  assert.equal(again.done, 20 - done);
});

test("a failing save does not stop the job or drop the translation from memory", async () => {
  const p = book(4);
  let saves = 0;
  const r = await runChapters(p, p.chapters, {
    call: async ({ user }) => ({ text: translateAll(user) }),
    lanes: 1,
    onChapter: () => { if (++saves === 2) throw new Error("QuotaExceededError"); },
  });
  assert.equal(r.done, 4);
  assert.ok(p.chapters[1].translation);
});

test("after a crash, chapters left 'working' go back to not-translated or done", () => {
  const p = book(2);
  p.chapters[0].status = "working";
  p.chapters[1].status = "working";
  p.chapters[1].translation = "เดิม";
  resetStuck(p);
  assert.deepEqual(p.chapters.map((c) => c.status), ["new", "done"]);
});

test("a translation split into more paragraphs than the source is not flagged (verse is often split)", () => {
  const r = checkTranslation("觀棋柯爛，伐木丁丁，雲邊谷口徐行。", "ดูหมากล้อมจนด้ามขวานผุ\n\nเสียงตัดไม้ดังป๊อกป๊อก\n\nเดินช้าๆ ริมหุบเขา", [], "zh", "th");
  assert.ok(r.ok);
});

test("review corrections are capped per chunk, and corrected paragraphs are re-checked in one request", async () => {
  const src = Array.from({ length: 8 }, (_, i) => `第${i}段：王五說明天去京城。`).join("\n\n");
  const out = Array.from({ length: 8 }, (_, i) => `ย่อหน้า ${i}: หวังอู่บอกว่าเมื่อวานไปเมืองหลวง`).join("\n\n");
  const p = project({ review: true, autoFix: false, maxCorrections: 3 });
  const ch = newChapter("一", src);
  p.chapters.push(ch);
  const every = { issues: Array.from({ length: 8 }, (_, i) => ({ paragraph: i + 1, type: "meaning", source: "明天", translation: "เมื่อวาน", problem: "tomorrow, not yesterday" })) };
  let translatorCalls = 0;
  // Each correction edits the one wrong word, as a correction should.
  const call = async ({ user }) => (translatorCalls++ ? { text: /TRANSLATED PARAGRAPH:\n<<<\n([\s\S]*?)\n>>>/.exec(user)[1].replace("เมื่อวาน", "พรุ่งนี้จะ") } : { text: out });
  const rv = reviewer([every, { issues: [] }]);
  await translateChapter(p, ch, { call, reviewCall: rv.call });
  assert.equal(translatorCalls - 1, 3, "three paragraphs corrected");
  assert.equal(rv.asked.length, 2, "one review, one re-check of all corrections");
  assert.equal(ch.review.fixed.length, 3);
  assert.equal(ch.review.unresolved.length, 5, "the rest is left for a human");
});

test("review findings are corrected even when the translation split paragraphs, using the quoted source", async () => {
  const src = "王五拿起劍。他對李四說：「明天我們去京城。」\n\n李四點了點頭。";
  const split = "หวังอู่หยิบกระบี่ขึ้นมา\n\nเขาพูดกับหลี่ซื่อว่า “เมื่อวานพวกเราไปเมืองหลวงมา”\n\nหลี่ซื่อพยักหน้า";
  const p = project({ review: true, autoFix: false });
  const ch = newChapter("一", src);
  p.chapters.push(ch);
  const sent = [];
  const call = async ({ user }) => (sent.push(user), { text: sent.length === 1 ? split : "เขาพูดกับหลี่ซื่อว่า “พรุ่งนี้พวกเราจะไปเมืองหลวง”" });
  const rv = reviewer([
    { issues: [
      { paragraph: 2, type: "meaning", source: "明天我們去京城", translation: "เมื่อวานพวกเราไปเมืองหลวงมา", problem: "tomorrow, not yesterday" },
      { paragraph: 3, type: "omission", source: "點了點頭", translation: "", problem: "nodding twice is lost" },
    ] },
    { issues: [] },
  ]);
  await translateChapter(p, ch, { call, reviewCall: rv.call });
  assert.ok(sent[1].includes("明天我們去京城") && !sent[1].includes("李四點了點頭"), "correction gets the source paragraph holding the quote");
  assert.equal(ch.translation.split("\n\n")[1], "เขาพูดกับหลี่ซื่อว่า “พรุ่งนี้พวกเราจะไปเมืองหลวง”");
  assert.equal(ch.review.fixed.length, 1);
  assert.deepEqual(ch.review.unresolved.map((u) => u.type), ["omission"], "an omission cannot be placed without aligned paragraphs");
  assert.equal(sent.length, 2);
});

// Seen with a real model: a "correction" that replaced the paragraph with the translation of another passage.
test("a correction that rewrites the paragraph into different text is rejected", async () => {
  const p = project({ review: true, autoFix: false });
  const ch = newChapter("一", REVIEW_SRC);
  p.chapters.push(ch);
  let n = 0;
  const call = async () => ({ text: n++ ? "ตั้งแต่ครั้งผานกู่เบิกฟ้าดิน สามราชาปกครองโลก ห้าจักรพรรดิบัญญัติกฎเกณฑ์ แบ่งออกเป็นสี่ทวีปใหญ่" : WRONG_OUT });
  const rv = reviewer([{ issues: [{ paragraph: 1, type: "meaning", source: "明天我們去京城", translation: "เมื่อวานพวกเราไปเมืองหลวงมา", problem: "tomorrow" }] }, { issues: [] }]);
  await translateChapter(p, ch, { call, reviewCall: rv.call });
  assert.equal(ch.translation, WRONG_OUT, "the translation is left as it was");
  assert.equal(ch.review.fixed.length, 0);
  assert.equal(ch.review.unresolved.length, 1);
});

test("when paragraphs are split and the quoted source occurs in two paragraphs, nothing is corrected", async () => {
  const src = "李四去了京城。\n\n後來李四又回到了京城。";
  const split = "หลี่ซื่อไป\n\nเมืองหลวง\n\nต่อมาหลี่ซื่อกลับมาที่เมืองหลวงอีก";
  const p = project({ review: true, autoFix: false });
  const ch = newChapter("一", src);
  p.chapters.push(ch);
  let calls = 0;
  const rv = reviewer([{ issues: [{ paragraph: 3, type: "name", source: "京城", translation: "เมืองหลวง", problem: "x" }] }]);
  await translateChapter(p, ch, { call: async () => (calls++, { text: split }), reviewCall: rv.call });
  assert.equal(calls, 1, "no correction request");
  assert.equal(ch.review.unresolved.length, 1);
});

test("a correction that returns the paragraph unchanged is not counted as fixed", async () => {
  const p = project({ review: true, autoFix: false });
  const ch = newChapter("一", REVIEW_SRC);
  p.chapters.push(ch);
  const rv = reviewer([{ issues: [{ paragraph: 2, type: "meaning", source: "李四點了點頭", translation: "หลี่ซื่อพยักหน้า", problem: "looks correct" }] }, { issues: [] }]);
  let n = 0;
  await translateChapter(p, ch, { call: async () => ({ text: n++ ? "หลี่ซื่อพยักหน้า" : GOOD_OUT }), reviewCall: rv.call });
  assert.equal(ch.review.fixed.length, 0);
  assert.equal(ch.review.unresolved.length, 1);
});

// Seen in real Gemini output: "h้อย" (a Latin h inside a Thai word), missed because short Latin words were ignored.
test("a Latin letter glued to Thai letters is flagged as a leak", () => {
  assert.deepEqual(checkTranslation("林檎碧實", "ผลไม้ห้อยh้อยระย้า", [], "zh", "th").leftovers, ["h"]);
  assert.ok(checkTranslation("He said OK", "เขาบอกว่า OK แล้ว", [], "en", "th").ok, "a spaced Latin word stays allowed");
});

test("when the main AI's quota is gone, the job carries on with the backup and does not go back", async () => {
  const p = book(6);
  let mainCalls = 0;
  const main = async ({ user }) => {
    if (++mainCalls > 3) throw new AIError("quota", "all gone");
    return { text: translateAll(user), model: "gemini" };
  };
  const backupUsed = [];
  const backup = async ({ user }) => (backupUsed.push(user), { text: translateAll(user), model: "pollinations" });
  let switched = 0;
  const call = withBackup(main, backup, () => switched++);
  const r = await runChapters(p, p.chapters, { call, lanes: 1 });
  assert.equal(r.done, 6);
  assert.equal(r.stopped, null);
  assert.equal(switched, 1);
  assert.equal(mainCalls, 4, "the main AI is not asked again after its quota ran out");
  assert.deepEqual(p.chapters.map((c) => c.models[0]), ["gemini", "gemini", "gemini", "pollinations", "pollinations", "pollinations"]);
});

test("errors other than quota are not hidden by the backup", async () => {
  const call = withBackup(async () => { throw new AIError("auth", "bad key"); }, async () => ({ text: "x" }), () => {});
  await assert.rejects(call({}), { kind: "auth" });
});

test("a request's onStart fires after its turn comes up, so waiting in line does not count as the AI being slow", async (t) => {
  fakeFetch(t, () => gemini("ok"));
  const call = createCaller({ ...fast, minIntervalMs: 80 });
  const t0 = Date.now();
  await call({ system: "s", user: "u" });
  let startedAfter = -1;
  await call({ system: "s", user: "u", onStart: () => (startedAfter = Date.now() - t0) });
  assert.ok(startedAfter >= 70, `started after ${startedAfter} ms`);
});

test("when the AI keeps failing (service down), the job stops after a few chapters instead of failing all of them", async () => {
  const p = book(100);
  let calls = 0;
  const r = await runChapters(p, p.chapters, { call: async () => { calls++; throw new AIError("network", "เซิร์ฟเวอร์ของผู้ให้บริการขัดข้อง (503)"); }, lanes: 2 });
  assert.equal(r.stopped, "failing");
  assert.ok(r.failed <= 4, `${r.failed} chapters failed before stopping`);
  assert.equal(p.chapters.filter((c) => c.status === "new").length, 100 - r.failed, "the rest stay not-translated for a later run");
});

test("a single network failure between successes does not stop the job", async () => {
  const p = book(10);
  let n = 0;
  const r = await runChapters(p, p.chapters, { call: async ({ user }) => { if (++n % 3 === 0) throw new AIError("network", "x"); return { text: translateAll(user) }; }, lanes: 1 });
  assert.equal(r.stopped, null);
  assert.ok(r.done >= 6);
});

// Seen on real Pollinations: "ขออภัย ฉันไม่สามารถดำเนินการตามคำขอนี้ได้" for a 7,000-character chapter, saved as its translation.
test("a refusal or a far-too-short reply is not saved as the translation; the chunk is split and tried again", async () => {
  const p = project({ autoFix: false });
  const para = "他走進了山洞，看見一隻猴子坐在石頭上。".repeat(10);
  const ch = newChapter("一", Array.from({ length: 6 }, () => para).join("\n\n"));
  p.chapters.push(ch);
  const sizes = [];
  const call = async ({ user }) => {
    const passage = passageOf(user);
    sizes.push(passage.length);
    return { text: passage.length > 1000 ? "ขออภัย ฉันไม่สามารถดำเนินการตามคำขอนี้ได้" : translateAll(user) };
  };
  await translateChapter(p, ch, { call });
  assert.ok(sizes.length > 1 && sizes.at(-1) < sizes[0], "the chunk was split");
  assert.ok(!ch.translation.includes("ขออภัย"));
  assert.equal(ch.translation.split("\n\n").length, 6);
});

test("a chapter whose every reply is a refusal ends as an error, not as done", async () => {
  const p = project({ autoFix: false });
  const ch = newChapter("一", "他走進了山洞，看見一隻猴子坐在石頭上，然後他們說了很久的話。\n\n天色漸漸暗了下來。");
  p.chapters.push(ch);
  await assert.rejects(translateChapter(p, ch, { call: async () => ({ text: "ขออภัย" }) }));
  assert.equal(ch.status, "error");
  assert.equal(ch.translation, "");
});
