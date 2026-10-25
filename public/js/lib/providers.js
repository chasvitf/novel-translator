// AI providers. Calls go straight from the browser to the provider with the user's own key;
// nothing passes through a server of ours.

export const PROVIDERS = {
  gemini: {
    name: "Google Gemini",
    badge: "ฟรี · ต้องมี key",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHelp: "เข้า aistudio.google.com/apikey → Create API key (ฟรี ไม่ต้องผูกบัตร)",
    defaultModel: "gemini-3.5-flash",
    // Free tier: about 20 requests per day per model, so the caller moves down this list as each runs out.
    models: ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemma-4-31b-it", "gemma-4-26b-a4b-it"],
    minIntervalMs: 4500,
    tested: true,
  },
  pollinations: {
    name: "Pollinations (ไม่ต้องมี key)",
    badge: "ฟรี · ไม่ต้องสมัคร · ช้า · คุณภาพต่ำกว่า",
    noKey: true,
    keyHelp: "ไม่ต้องมี key แต่ช้า (1 ครั้งต่อ 30 วินาที) และสำนวนด้อยกว่า Gemini ใช้งานจริงแนะนำ Gemini",
    endpoint: "https://text.pollinations.ai/openai",
    defaultModel: "openai",
    models: ["openai"],
    minIntervalMs: 31000,
    tested: true,
  },
  groq: {
    name: "Groq",
    badge: "ต้องมี key · คิดค่าบริการตาม token",
    keyUrl: "https://console.groq.com/keys",
    keyHelp: "เข้า console.groq.com/keys → Create API Key · ตรวจสอบราคาโมเดลก่อนใช้งาน",
    base: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
    minIntervalMs: 2500,
  },
  openrouter: {
    name: "OpenRouter",
    badge: "มีโมเดลฟรี · ต้องมี key",
    keyUrl: "https://openrouter.ai/keys",
    keyHelp: "เข้า openrouter.ai/keys → Create Key แล้วเลือกโมเดลที่ลงท้าย :free",
    base: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-chat-v3.1:free",
    models: [],
    minIntervalMs: 3500,
  },
  openai: {
    name: "OpenAI",
    badge: "เสียเงิน",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHelp: "เข้า platform.openai.com/api-keys (ต้องเติมเงิน)",
    base: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    models: [],
    minIntervalMs: 500,
  },
  anthropic: {
    name: "Anthropic Claude",
    badge: "เสียเงิน · สำนวนดีมาก",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHelp: "เข้า console.anthropic.com → API Keys (ต้องเติมเงิน)",
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    minIntervalMs: 500,
  },
  custom: {
    name: "อื่นๆ (OpenAI-compatible / Ollama ในเครื่อง)",
    badge: "ใส่ URL เอง",
    keyHelp: "เช่น Ollama: http://localhost:11434/v1 (key เว้นว่างได้)",
    base: "",
    defaultModel: "",
    models: [],
    minIntervalMs: 0,
  },
};

export class AIError extends Error {
  constructor(kind, message, retryAfterMs = 0) {
    super(message);
    this.kind = kind; // rate | quota | auth | blocked | network | length | bad
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("หยุดแล้ว", "AbortError"));
    }, { once: true });
  });

async function post(url, headers, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new AIError("network", `เชื่อมต่อไม่ได้: ${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* some errors are plain text */
  }
  if (!res.ok) throw httpError(res, data, text);
  return data ?? text;
}

function httpError(res, data, text) {
  const msg = data?.error?.message || data?.message || (typeof data?.error === "string" ? data.error : "") || text.slice(0, 300);
  const retryHeader = Number(res.headers.get("retry-after")) * 1000 || 0;
  // Gemini puts the wait in error.details[].retryDelay ("23s").
  const geminiDelay = (data?.error?.details || []).map((d) => parseFloat(d.retryDelay)).find((n) => n > 0);
  const pollDelay = /retry after (\d+)s/i.exec(msg)?.[1];
  const wait = retryHeader || (geminiDelay ? geminiDelay * 1000 : 0) || (pollDelay ? Number(pollDelay) * 1000 : 0);
  if (res.status === 429 || data?.error?.code === "FREE_LIMIT" || (res.status === 402 && /limit/i.test(msg))) {
    const quotaIds = (data?.error?.details || []).flatMap((d) => (d.violations || []).map((v) => v.quotaId || "")).join(" ");
    const daily = /per ?day|daily|PerDay/i.test(`${msg} ${quotaIds}`) || wait > 15 * 60 * 1000;
    return daily ? new AIError("quota", `โควตาฟรีของวันนี้หมดแล้ว (${msg.slice(0, 120)})`) : new AIError("rate", `ถูกจำกัดความถี่: ${msg.slice(0, 160)}`, wait);
  }
  if (res.status === 401 || res.status === 403 || /api key not valid|invalid api key|unauthorized/i.test(msg)) return new AIError("auth", `key ใช้ไม่ได้: ${msg.slice(0, 160)}`);
  if (res.status >= 500) return new AIError("network", `เซิร์ฟเวอร์ของผู้ให้บริการขัดข้อง (${res.status})`, 5000);
  return new AIError("bad", `${res.status}: ${msg.slice(0, 300)}`);
}

// ---------- Gemini (native API) ----------

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "BLOCK_NONE" }));

async function gemini(cfg, { system, user, json, signal }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: json ? 0.2 : 0.7,
      maxOutputTokens: 32768,
      ...(cfg.model === "gemini-3.5-flash" ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
    safetySettings: SAFETY,
  };
  const d = await post(`${GEMINI}/models/${encodeURIComponent(cfg.model)}:generateContent`, { "x-goog-api-key": cfg.key }, body, signal);
  if (d.promptFeedback?.blockReason) throw new AIError("blocked", `Gemini ไม่ยอมแปลท่อนนี้ (${d.promptFeedback.blockReason})`);
  const cand = d.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!text) throw new AIError(cand?.finishReason === "SAFETY" || cand?.finishReason === "PROHIBITED_CONTENT" ? "blocked" : "bad", `Gemini ตอบว่างเปล่า (${cand?.finishReason || "ไม่ทราบสาเหตุ"})`);
  if (cand.finishReason === "MAX_TOKENS") throw new AIError("length", "คำตอบยาวเกินที่ AI ตอบได้ในครั้งเดียว");
  return { text, usage: d.usageMetadata?.totalTokenCount || 0 };
}

async function geminiModels(cfg) {
  const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": cfg.key } });
  if (!r.ok) throw httpError(r, await r.json().catch(() => null), "");
  const d = await r.json();
  const skip = /tts|image|robotics|computer|embed|transcribe|research|antigravity|lyria|banana|omni|customtools|aqa|argon/i;
  return d.models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && !skip.test(m.name))
    .map((m) => m.name.replace(/^models\//, ""));
}

// ---------- OpenAI-compatible (Groq, OpenRouter, OpenAI, Pollinations, Ollama…) ----------

function compatUrl(p, cfg) {
  if (p.endpoint) return p.endpoint;
  const base = (cfg.base || p.base || "").replace(/\/+$/, "");
  if (!base) throw new AIError("bad", "ยังไม่ได้ใส่ URL ของผู้ให้บริการ");
  return `${base}/chat/completions`;
}

async function compat(cfg, { system, user, json, signal }) {
  const p = PROVIDERS[cfg.provider];
  const headers = {};
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
  if (cfg.provider === "openrouter") {
    headers["HTTP-Referer"] = typeof location !== "undefined" ? location.origin : "https://novel-th.vercel.app";
    headers["X-Title"] = "Novel Lock";
  }
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  // Reasoning models on OpenAI reject a custom temperature.
  if (cfg.provider !== "openai") body.temperature = json ? 0.2 : 0.7;
  if (json && cfg.provider !== "pollinations") body.response_format = { type: "json_object" };
  // Pollinations' "openai" is a reasoning model: with default effort it can spend the whole budget thinking.
  if (cfg.provider === "pollinations") Object.assign(body, { reasoning_effort: "low", max_tokens: 16000 });
  const d = await post(compatUrl(p, cfg), headers, body, signal);
  if (typeof d === "string") return { text: d, usage: 0 };
  const choice = d.choices?.[0];
  let text = choice?.message?.content || "";
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); // qwen/deepseek reasoning traces
  if (!text && choice?.finish_reason === "length") throw new AIError("length", "คำตอบยาวเกินที่ AI ตอบได้ในครั้งเดียว");
  if (!text) throw new AIError(choice?.finish_reason === "content_filter" ? "blocked" : "bad", `AI ตอบว่างเปล่า (${choice?.finish_reason || "ไม่ทราบสาเหตุ"})`);
  if (choice.finish_reason === "length") throw new AIError("length", "คำตอบยาวเกินที่ AI ตอบได้ในครั้งเดียว");
  return { text, usage: d.usage?.total_tokens || 0 };
}

async function compatModels(cfg) {
  const p = PROVIDERS[cfg.provider];
  if (p.endpoint) return p.models;
  const base = (cfg.base || p.base || "").replace(/\/+$/, "");
  const r = await fetch(`${base}/models`, { headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {} });
  if (!r.ok) throw httpError(r, await r.json().catch(() => null), "");
  const ids = ((await r.json()).data || []).map((m) => m.id);
  if (cfg.provider === "openrouter") return ids.filter((id) => id.endsWith(":free")).concat(ids.filter((id) => !id.endsWith(":free")));
  if (cfg.provider === "openai") return ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|image|tts|transcribe|search/.test(id));
  if (cfg.provider === "groq") return ids.filter((id) => !/whisper|tts|guard|orpheus/.test(id));
  return ids;
}

// ---------- Anthropic (official SDK, loaded on demand) ----------

let loadAnthropic = () => import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm").then((m) => m.default);
export const setAnthropicLoader = (fn) => (loadAnthropic = fn);

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5"]);

async function anthropicClient(cfg) {
  const Anthropic = await loadAnthropic();
  return { Anthropic, client: new Anthropic({ apiKey: cfg.key, dangerouslyAllowBrowser: true, maxRetries: 0 }) };
}

function anthropicError(Anthropic, e) {
  if (e instanceof Anthropic.RateLimitError) return new AIError("rate", `ถูกจำกัดความถี่: ${e.message}`, Number(e.headers?.get?.("retry-after")) * 1000 || 0);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AIError("auth", `key ใช้ไม่ได้: ${e.message}`);
  if (e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) return new AIError("network", e.message, 5000);
  if (e instanceof Anthropic.APIError) return new AIError("bad", e.message);
  return e;
}

async function anthropic(cfg, { system, user, json, signal }) {
  const { Anthropic, client } = await anthropicClient(cfg);
  const params = {
    model: cfg.model,
    max_tokens: 16000,
    system: json ? `${system}\nReply with the JSON object only.` : system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "medium" },
  };
  // Opt into server-side fallbacks so a refusal is retried on another model.
  if (FALLBACK_MODELS.has(cfg.model)) Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  let msg;
  try {
    msg = await client.beta.messages.create(params, { signal });
  } catch (e) {
    throw anthropicError(Anthropic, e);
  }
  if (msg.stop_reason === "refusal") throw new AIError("blocked", "Claude ไม่ยอมแปลท่อนนี้");
  if (msg.stop_reason === "max_tokens") throw new AIError("length", "คำตอบยาวเกินที่ AI ตอบได้ในครั้งเดียว");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, usage: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0) };
}

async function anthropicModels(cfg) {
  const { Anthropic, client } = await anthropicClient(cfg);
  try {
    const ids = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  } catch (e) {
    throw anthropicError(Anthropic, e);
  }
}

// ---------- public API ----------

export function complete(cfg, req) {
  if (!PROVIDERS[cfg.provider]) throw new AIError("bad", "ไม่รู้จักผู้ให้บริการนี้");
  if (!cfg.key && !PROVIDERS[cfg.provider].noKey && cfg.provider !== "custom") throw new AIError("auth", "ยังไม่ได้ใส่ API key");
  if (cfg.provider === "gemini") return gemini(cfg, req);
  if (cfg.provider === "anthropic") return anthropic(cfg, req);
  return compat(cfg, req);
}

export function listModels(cfg) {
  if (cfg.provider === "gemini") return geminiModels(cfg);
  if (cfg.provider === "anthropic") return anthropicModels(cfg);
  return compatModels(cfg);
}

// Spaces calls out per provider and retries rate limits and network errors. Moves on to the next
// model in `cfg.fallbackModels` when a model's daily free quota runs out (each model has its own),
// when it keeps answering "overloaded", or when it refuses a passage (often a false positive of one
// model). `exhausted` is a Set of "provider/model" keys the app can persist for the day.
const ALL_GONE = "โควตาฟรีของวันนี้หมดทุกโมเดลแล้ว ลองใหม่พรุ่งนี้ หรือเปลี่ยนผู้ให้บริการ/ใส่ key อื่น";

// A request with no reply after this long is treated as a network error and retried; without it one
// hung connection stalls its worker for the rest of the run.
const TIMEOUT_MS = 180_000;

// The provider's answer, or a timeout as a retryable network error. Stopping the run stays an AbortError.
async function completeWithTimeout(cfg, req) {
  const ms = cfg.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const stop = () => controller.abort();
  req.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, ms);
  try {
    return await complete(cfg, { ...req, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted && !req.signal?.aborted) throw new AIError("network", `AI ไม่ตอบภายใน ${Math.round(ms / 1000)} วินาที`);
    throw e;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", stop);
  }
}

export function createCaller(cfg, { onWait, onSwitch, exhausted = new Set(), maxAttempts = 6, retryBaseMs = 2000 } = {}) {
  const minGap = cfg.minIntervalMs ?? PROVIDERS[cfg.provider]?.minIntervalMs ?? 0;
  const chain = [cfg.model, ...(cfg.fallbackModels || [])].filter((m, i, a) => m && a.indexOf(m) === i);
  const keyOf = (m) => `${cfg.provider}/${m}`;
  let nextSlot = 0;

  // Reserve start times synchronously so parallel workers honor the provider gap instead
  // of waking together and accidentally sending a burst.
  async function waitForSlot(signal) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minGap;
    const gap = slot - now;
    if (gap > 0) {
      if (gap > 3000) onWait?.(gap, "เว้นระยะตามโควตา");
      await sleep(gap, signal);
    }
  }

  async function attempt(model, req) {
    for (let n = 1; ; n++) {
      await waitForSlot(req.signal);
      req.onStart?.(); // time limits on the answer start here, not while waiting for a turn
      try {
        return await completeWithTimeout({ ...cfg, model }, req);
      } catch (e) {
        if (!(e instanceof AIError)) throw e;
        // A 503 means this model is currently overloaded. Move to another configured model
        // immediately instead of making the user wait through repeated retries.
        if (e.kind === "network" && /\(503\)/.test(e.message) && chain.length > 1) {
          e.kind = "overloaded";
          throw e;
        }
        if (!(e.kind === "rate" || e.kind === "network") || n >= maxAttempts) throw e;
        // Jitter keeps parallel workers that hit the same limit from retrying in lockstep.
        // A rate limit without a stated wait gets 10× the base delay (20 seconds by default).
        const floor = e.retryAfterMs || (e.kind === "rate" ? retryBaseMs * 10 : 0);
        const wait = Math.max(floor, retryBaseMs * 2 ** (n - 1) * (0.75 + Math.random() * 0.5));
        onWait?.(wait, e.message);
        await sleep(wait, req.signal);
      }
    }
  }

// A model that answers 503 is passed over for a while, so the next calls don't retry it first.
// When every model is cooling down, they are tried anyway.
  const cooling = new Map();
  const OVERLOAD_COOLDOWN_MS = 3 * 60 * 1000;

  return async function call(req) {
    const skip = new Set();
    let lastErr = null;
    for (;;) {
      const usable = (m) => !exhausted.has(keyOf(m)) && !skip.has(m);
      const model = chain.find((m) => usable(m) && !(cooling.get(m) > Date.now())) || chain.find(usable);
      if (!model) throw lastErr && lastErr.kind !== "quota" ? lastErr : new AIError("quota", ALL_GONE);
      try {
        return { ...(await attempt(model, req)), model };
      } catch (e) {
        if (!(e instanceof AIError) || !["quota", "blocked", "overloaded"].includes(e.kind)) throw e;
        if (e.kind === "quota") exhausted.add(keyOf(model));
        if (e.kind === "overloaded") {
          e.kind = "network";
          cooling.set(model, Date.now() + OVERLOAD_COOLDOWN_MS);
        }
        skip.add(model);
        lastErr = e;
        const next = chain.find((m) => !exhausted.has(keyOf(m)) && !skip.has(m));
        if (next) onSwitch?.(model, next, e.message);
      }
    }
  };
}

// Once `main` has run out of quota on every model, send this and every later call to `backup`.
export function withBackup(main, backup, onSwitch) {
  let switched = false;
  return async function call(req) {
    if (!switched) {
      try {
        return await main(req);
      } catch (e) {
        if (e.kind !== "quota") throw e;
        switched = true;
        onSwitch?.(e);
      }
    }
    return backup(req);
  };
}
