// OpenAI-compatible fake AI for browser tests. One Thai paragraph per source paragraph (so the structure
// checks pass), JSON for term analysis and review. MOCK_DELAY ms per reply (default 800), MOCK_FAIL a
// fraction of requests answered 503 or 429 to exercise retries. /stats counts requests per chapter.
import http from "node:http";
const delay = Number(process.env.MOCK_DELAY ?? 800);
const failRate = Number(process.env.MOCK_FAIL ?? 0);
let inflight = 0, peak = 0, total = 0, failed = 0;
const translated = new Map(); // chapter marker → translate requests
http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  if (req.url === "/stats") {
    const counts = [...translated.values()];
    return res.end(JSON.stringify({ peak, total, inflight, failed, chapters: translated.size, maxPerChapter: Math.max(0, ...counts) }));
  }
  let body = ""; for await (const c of req) body += c;
  inflight++; total++; peak = Math.max(peak, inflight);
  await new Promise((r) => setTimeout(r, delay));
  inflight--;
  if (Math.random() < failRate) {
    failed++;
    const rate = Math.random() < 0.5;
    res.statusCode = rate ? 429 : 503;
    if (rate) res.setHeader("retry-after", "1");
    return res.end(JSON.stringify({ error: { message: rate ? "Rate limit reached, per minute" : "overloaded" } }));
  }
  const user = JSON.parse(body).messages?.at(-1)?.content || "";
  let content;
  if (/SOURCE PARAGRAPHS:/.test(user)) content = JSON.stringify({ issues: [] });
  else if (/Return JSON|JSON only/.test(body)) content = JSON.stringify({ title: "ตอนทดสอบ", summary: "สรุป", terms: [] });
  else {
    const passage = /PASSAGE TO TRANSLATE:\n<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? "x";
    const mark = /【(\d+)-(\d+)】/.exec(passage)?.slice(1).join("-");
    if (mark) translated.set(mark, (translated.get(mark) || 0) + 1);
    const th = (p) => "คำแปลทดสอบ".repeat(Math.max(1, Math.round(p.length / 6)));
    content = passage.split(/\n\n/).map((p) => (/[「『“"]/.test(p) ? `“${th(p)}”` : th(p))).join("\n\n");
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: Math.round(body.length / 3) }, model: "mock" }));
}).listen(8788);
