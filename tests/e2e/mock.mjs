import http from "node:http";
let inflight = 0, peak = 0, total = 0;
http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  if (req.url === "/stats") return res.end(JSON.stringify({ peak, total, inflight }));
  let body = ""; for await (const c of req) body += c;
  inflight++; total++; peak = Math.max(peak, inflight);
  await new Promise((r) => setTimeout(r, 800));
  inflight--;
  const wantsJson = /JSON|json/.test(body);
  const content = wantsJson ? JSON.stringify({ title: "ตอนทดสอบ", summary: "สรุป", terms: [] }) : "นี่คือคำแปลทดสอบของย่อหน้านี้";
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content } }], model: "mock" }));
}).listen(8788);
