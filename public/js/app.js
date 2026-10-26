import { LANGS, GENRES, NAME_STYLES, langByCode, detectLang, chunkSizeFor } from "./lib/langs.js";
import { splitChapters, chunkText } from "./lib/split.js";
import { TERM_TYPES, typeName, makeEntry, parseCSV, toCSV, countInText, relevantEntries, issueCount } from "./lib/glossary.js";
import { PROVIDERS, createCaller, listModels } from "./lib/providers.js";
import { translateChapter, recheckChapter, fixChapter, newChapter, runChapters, resetStuck as resetStuckChapters } from "./lib/pipeline.js";
import * as store from "./lib/store.js";
import * as files from "./lib/files.js";

const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n || 0).toLocaleString("th-TH");

const state = {
  projects: [],
  project: null,
  view: "home",
  chapterId: null,
  selected: new Set(),
  editing: false,
  glossFilter: { q: "", type: "", status: "" },
  run: null, // { abort, done, total, log: [] }
  pendingImport: null,
};

// ---------------- AI settings (per device) ----------------

const DEFAULT_AI = { provider: "gemini", model: PROVIDERS.gemini.defaultModel, keys: {}, base: "", fallback: true, models: {}, parallel: 1, paid: false };
const ai = () => {
  const savedSettings = store.prefs.get("ai", {}) || {};
  const settings = { ...DEFAULT_AI, ...savedSettings };
  if (!PROVIDERS[settings.provider]) {
    settings.provider = DEFAULT_AI.provider;
    settings.model = DEFAULT_AI.model;
    store.prefs.set("ai", settings);
  }
  const groqReplacements = {
    "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
    "qwen/qwen3-32b": "openai/gpt-oss-120b",
  };
  const savedGroqModels = settings.models?.groq || [];
  const migratedGroqModels = [...new Set(savedGroqModels.map((model) => groqReplacements[model] || model))];
  const savedLastGroqModel = settings.models?.["last:groq"];
  const migratedLastGroqModel = groqReplacements[savedLastGroqModel] || savedLastGroqModel;
  if (settings.model && settings.provider === "groq" && groqReplacements[settings.model]) {
    settings.model = groqReplacements[settings.model];
  }
  if (savedGroqModels.some((model) => groqReplacements[model]) || migratedLastGroqModel !== savedLastGroqModel) {
    settings.models = { ...settings.models, groq: migratedGroqModels, ...(migratedLastGroqModel ? { "last:groq": migratedLastGroqModel } : {}) };
  }
  // Roll back the model value saved by the recent 3.8-default release. Mark it once so users can
  // deliberately select 3.8 again later without the migration overriding their choice.
  const groqMigrated = (savedSettings.provider === "groq" && !!groqReplacements[savedSettings.model]) || migratedGroqModels.some((model, i) => model !== savedGroqModels[i]) || migratedLastGroqModel !== savedLastGroqModel;
  if (groqMigrated) {
    store.prefs.set("ai", settings);
  }
  if (settings.provider === "gemini" && settings.model === "gemini-3.8-flash" && settings.geminiRollback !== "3.5") {
    settings.model = PROVIDERS.gemini.defaultModel;
    settings.geminiRollback = "3.5";
    store.prefs.set("ai", settings);
  }
  return settings;
};
const saveAI = (patch) => store.prefs.set("ai", { ...ai(), ...patch });
// Gemini free quotas reset at midnight Pacific time.
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const exhaustedSet = () => new Set(store.prefs.get(`exhausted:${today()}`, []));

function aiConfig() {
  const a = ai();
  const p = PROVIDERS[a.provider];
  const fallbackModels = a.fallback ? (a.models[a.provider]?.length ? orderFallbacks(a.provider, a.models[a.provider]) : p.models) : [];
  // A paid key has no free-tier spacing to respect; keep a small gap so bursts don't trip rate limits.
  const keys = keyList(a);
  return { provider: a.provider, model: a.model || p.defaultModel, key: keys[0] || "", keys, base: a.base, fallbackModels, ...(a.paid ? { minIntervalMs: 300 } : {}) };
}

// Up to MAX_KEYS keys per provider, saved one per line; free quota is counted per key.
const MAX_KEYS = 10;
const keyList = (a = ai()) => [...new Set(String(a.keys[a.provider] || "").split(/\s+/).filter(Boolean))].slice(0, MAX_KEYS);

// Prefer the curated order, then whatever else the account lists.
function orderFallbacks(provider, listed) {
  const curated = PROVIDERS[provider].models.filter((m) => listed.includes(m));
  return curated.length ? curated : listed.slice(0, 6);
}

// The independent check runs on another model of the same provider when there is one, so the model
// that wrote a translation is not the only one judging it (and free quota is spread over two models).
function reviewConfig() {
  const c = aiConfig();
  const other = c.fallbackModels.find((m) => m !== c.model);
  return other ? { ...c, model: other, fallbackModels: [other, ...c.fallbackModels.filter((m) => m !== other)] } : c;
}

function aiReady() {
  const c = aiConfig();
  return c.provider === "custom" || !!c.key;
}

function renderPill() {
  const c = aiConfig();
  const pill = $("#aiPill");
  pill.className = `ai-pill${aiReady() ? "" : " off"}`;
  pill.innerHTML = `<span class="dot"></span>${aiReady() ? `${esc(PROVIDERS[c.provider].name)} · ${esc(c.model)}` : "ตั้งค่า AI ก่อนแปล"}`;
}

// ---------------- projects ----------------

function blankProject(name, srcLang = "zh") {
  return {
    id: `p${Date.now().toString(36)}`,
    name,
    srcLang,
    tgtLang: "th",
    genre: srcLang === "zh" ? "wuxia" : srcLang === "en" ? "fantasy" : "modern",
    nameStyle: "",
    custom: "",
    polish: false,
    autoFix: true,
    autoTerms: "auto",
    chunkSize: 0,
    glossary: [],
    chapters: [],
    createdAt: Date.now(),
  };
}

let saveTimer = 0;
function save(now = false) {
  clearTimeout(saveTimer);
  const p = state.project;
  if (!p) return;
  const run = () => store.saveProject(p).catch((e) => toast(`บันทึกไม่ได้: ${e.message}`));
  if (now) return run();
  saveTimer = setTimeout(run, 400);
}

function resetStuck(p) {
  if (!busy()) resetStuckChapters(p);
}

async function openProject(id) {
  state.project = await store.getProject(id);
  if (!state.project) return go("home");
  if (Object.hasOwn(state.project, "translationMode")) {
    delete state.project.translationMode;
    await store.saveProject(state.project);
  }
  resetStuck(state.project);
  // Counts saved by older checks (paragraphs compared across chunks, names in quotes taken for dialogue,
  // shifted paragraphs): redo them once. Raise the number when the checks change again.
  if (state.project.checked !== 3) {
    state.project.chapters.forEach((c) => recheckChapter(state.project, c));
    state.project.checked = 3;
    await store.saveProject(state.project);
  }
  store.prefs.set("last", id);
  state.selected = new Set();
  state.chapterId = state.project.chapters[0]?.id || null;
  go("chapters");
  // A run cut off by the page closing (Android discards a tab left in the background) goes on by itself.
  const left = store.prefs.get(`run:${id}`, []);
  if (left.length && !busy()) {
    toast(`แปลต่อจากที่ค้างไว้ ${left.length} ตอน`);
    runQueue(left);
  }
}

async function refreshProjects() {
  state.projects = (await store.listProjects()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ---------------- routing / chrome ----------------

function go(view, { fromHistory = false } = {}) {
  if (view !== "home" && view !== "ai" && !state.project) view = "home";
  // Each page gets a history entry so the browser's back button moves between pages.
  const entry = { view, project: state.project?.id || null, chapter: state.chapterId || null };
  if (fromHistory) history.replaceState(entry, "", `#${view}`);
  else {
    const cur = history.state;
    if (!cur) history.replaceState(entry, "", `#${view}`);
    else if (cur.view !== view || cur.project !== entry.project) history.pushState(entry, "", `#${view}`);
  }
  state.view = view;
  state.editing = false;
  render();
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

function render() {
  renderPill();
  const p = state.project;
  for (const b of $("#tabs").children) {
    const needsProject = b.dataset.view !== "home" && b.dataset.view !== "ai";
    b.disabled = needsProject && !p;
    b.title = b.disabled ? "สร้างหรือเปิดเรื่องก่อน" : "";
    if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  $("#topProject").innerHTML = p && state.view !== "home" ? `<span class="muted small">โปรเจกต์</span> <b>${esc(p.name)}</b> <span class="badge">${esc(langByCode(p.srcLang).name)} → ${esc(langByCode(p.tgtLang).name)}</span>` : "";
  const views = { home: viewHome, chapters: viewChapters, book: viewBook, read: viewRead, glossary: viewGlossary, settings: viewSettings, export: viewExport, ai: viewAI };
  main.innerHTML = views[state.view]();
  afterRender[state.view]?.();
  renderRunner();
}

const afterRender = {};

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

// ---------------- home ----------------

// Same six steps as the user guide (คู่มือการใช้งาน) in Figma.
const GUIDE = [
  { t: "ตั้งค่า AI (ฟรี)", d: `ขอ key ฟรีที่ <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> วางในหน้าตั้งค่า AI แล้วกด <b>ทดสอบการเชื่อมต่อ</b>` },
  { t: "สร้างเรื่อง & ใส่นิยาย", d: "กด <b>+ สร้างโปรเจกต์ใหม่</b> แล้วลากไฟล์ .txt .docx .epub มาวาง (กี่ร้อยกี่พันตอนก็ได้) แอปแยกตอนให้เอง" },
  { t: "กดแปล", d: "แท็บ <b>ตอน</b> กด <b>แปลที่ยังไม่แปล</b> เพื่อแปลทุกตอน หรือกด <b>แปล</b> ท้ายแถวเพื่อแปลตอนเดียว ชื่อตัวละครระบบจำให้เอง" },
  { t: "อ่าน", d: "ตอนไหนเสร็จแล้วกด <b>อ่าน</b> ได้เลย ไม่ต้องรอตอนอื่น" },
  { t: "ส่งออกไฟล์", d: "แท็บ <b>ส่งออก</b> กด <b>Word .docx</b> หรือ <b>E-book .epub</b> และดาวน์โหลดไฟล์สำรองเก็บไว้" },
];

function viewHome() {
  // The open story may have been renamed or translated since the list was loaded.
  const cur = state.project;
  if (cur) state.projects = state.projects.map((x) => (x.id === cur.id ? cur : x));
  const list = state.projects.length
    ? `<ul class="projects">${state.projects
        .map(
          (p) => `<li><div class="grow"><b>${esc(p.name)}</b><div class="muted small">${esc(langByCode(p.srcLang).name)} → ${esc(langByCode(p.tgtLang).name)} · ${p.chapters.length} ตอน · แปลแล้ว ${p.chapters.filter((c) => c.translation).length} · จำชื่อไว้ ${p.glossary.length} คำ</div></div>
          <button class="btn sm" data-action="open" data-id="${p.id}">เปิด</button>
          <button class="btn sm ghost danger" data-action="delete-project" data-id="${p.id}" aria-label="ลบ ${esc(p.name)}">ลบ</button></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">ยังไม่มีเรื่อง กด <b>+ สร้างโปรเจกต์ใหม่</b> เพื่อเริ่ม</p>`;
  return `
  <section class="hero">
    <div>
      <p class="eyebrow">NOVEL LOCK</p>
      <h1>แปลนิยาย <em>ชื่อไม่เพี้ยน</em></h1>
      <p class="lede">แปลนิยายต่างประเทศเป็นภาษาไทย ทำตามคู่มือด้านล่าง ${GUIDE.length} ขั้นจบ</p>
      <div class="row"><button class="btn primary" data-action="new-project">+ สร้างโปรเจกต์ใหม่</button><button class="btn" data-action="view" data-view="ai">ตั้งค่า AI</button><label class="btn ghost">กู้คืนจากไฟล์สำรอง<input type="file" id="restoreIn" accept=".json" hidden></label></div>
    </div>
    <img class="hero-logo" src="/favicon.svg" alt="" width="200" height="200">
  </section>
  <div class="card"><h2>เรื่องของคุณ</h2>${list}</div>
  <div class="card">
    <h2>คู่มือ ${GUIDE.length} ขั้น</h2>
    <ol class="guide">${GUIDE.map((s, i) => `<li><span class="num" aria-hidden="true">${i + 1}</span><div><small class="step-of">ขั้นที่ ${i + 1} จาก ${GUIDE.length}</small><b>${s.t}</b><p>${s.d}</p></div></li>`).join("")}</ol>
  </div>
  <div class="card small muted">
    <h3>เก็บข้อมูลยังไง</h3>
    นิยายและคำแปลเก็บในเบราว์เซอร์เครื่องนี้เท่านั้น (สำรองเป็นไฟล์ได้ที่แท็บ “ส่งออก”) ·
    API key เก็บในเครื่องนี้ และส่งตรงไปที่ผู้ให้บริการ AI ที่คุณเลือก ไม่ผ่านเซิร์ฟเวอร์ของเรา
  </div>`;
}

async function newProjectDialog() {
  const name = prompt("ชื่อเรื่อง (เปลี่ยนทีหลังได้)", "นิยายเรื่องใหม่");
  if (!name) return;
  const p = blankProject(name.trim());
  await store.saveProject(p);
  await refreshProjects();
  state.project = p;
  store.prefs.set("last", p.id);
  go("chapters");
  toast("สร้างโปรเจกต์แล้ว เพิ่มตอนแรกได้เลย");
}

// ---------------- chapters ----------------

const STATUS = {
  new: ["ยังไม่แปล", ""],
  working: ["กำลังแปล", "run"],
  done: ["แปลเสร็จแล้ว", "ok"],
  error: ["ผิดพลาด", "err"],
};

function chapterBadge(c) {
  const [t, cls] = STATUS[c.status] || STATUS.new;
  const status = `<span class="badge ${cls}" ${c.error ? `title="${esc(c.error)}"` : ""}>${t}</span>`;
  return status;
}

// What the automatic checks found, in one line per kind (for the reader).
function issueLines(c) {
  const i = c.issues || { missing: [], leftovers: [], structure: [] };
  const kind = { paragraphs: (s) => `ย่อหน้าไม่ครบ: ต้นฉบับ ${s.src} ย่อหน้า คำแปล ${s.out} ย่อหน้า`, short: (s) => `ย่อหน้าสั้นผิดปกติ อาจแปลไม่ครบ: “${s.src}”`, dialogue: (s) => `บทพูดไม่มีเครื่องหมายคำพูด: “${s.src}”` };
  return [
    ...i.missing.map((m) => `ชื่อไม่ตรง: ${m.entry.source} ต้องเป็น “${m.entry.target}”`),
    ...i.leftovers.map((t) => `ยังไม่ได้แปล: ${t}`),
    ...(i.structure || []).map((s) => kind[s.kind]?.(s) || s.kind),
    ...(c.review?.unresolved || []).map((r) => `AI ตรวจพบ (${r.type}): ${r.problem} · “${r.source}”`),
  ];
}

function estimateCalls(p, chapters) {
  const size = Number(p.chunkSize) || chunkSizeFor(p.srcLang);
  return chapters.reduce((n, c) => n + (p.autoTerms !== "off" ? 1 : 0) + chunkText(c.text, size).length * ((p.polish ? 2 : 1) + (p.review ? 1 : 0)), 0);
}

function viewChapters() {
  const p = state.project;
  const rows = p.chapters
    .map(
      (c, i) => `<tr>
      <td><input type="checkbox" data-action="select" data-id="${c.id}" ${state.selected.has(c.id) ? "checked" : ""} aria-label="เลือก ${esc(c.title)}"></td>
      <td class="muted hide-sm">${i + 1}</td>
      <td class="ch-title"><a href="#" data-action="read-book" data-id="${c.id}">${esc(c.titleT || c.title)}</a>${c.titleT && c.titleT !== c.title ? `<small>${esc(c.title)}</small>` : ""}</td>
      <td class="muted small hide-sm">${fmt(c.text.length)} ตัวอักษร</td>
      <td>${chapterBadge(c)}${c.error ? `<div class="small" style="color:var(--accent)">${esc(c.error.slice(0, 120))}</div>` : ""}</td>
      <td><div class="row end" style="flex-wrap:nowrap">${c.translation ? `<button class="btn sm primary" data-action="read-book" data-id="${c.id}">อ่าน</button>` : ""}<button class="btn sm" data-action="translate-one" data-id="${c.id}">${c.translation ? "แปลใหม่" : "แปล"}</button><button class="btn sm ghost danger" data-action="delete-chapter" data-id="${c.id}" aria-label="ลบตอน">ลบ</button></div></td>
    </tr>`,
    )
    .join("");
  const todo = p.chapters.filter((c) => !c.translation);
  const sel = p.chapters.filter((c) => state.selected.has(c.id));
  const pending = state.pendingImport;
  return `
  <div class="card">
    <h2>เพิ่มตอน</h2>
    <div class="drop" id="drop">
      <p style="margin:0 0 8px">ลากไฟล์มาวาง หรือ <label class="btn sm" style="display:inline-flex">เลือกไฟล์<input type="file" id="fileIn" accept=".txt,.md,.docx,.epub,text/plain" multiple hidden></label></p>
      <span class="small">.txt .docx .epub · แยกตอนจากหัวข้ออัตโนมัติ เช่น 第1章 / 제1화 / 第1話 / Chapter 1 / Chương 1 / ตอนที่ 1 หรือคั่นด้วยบรรทัด ===</span>
    </div>
    <details style="margin-top:12px" ${p.chapters.length ? "" : "open"}>
      <summary>หรือวางข้อความ</summary>
      <textarea id="pasteIn" placeholder="วางเนื้อหานิยายที่นี่ (หลายตอนได้)" style="margin-top:8px"></textarea>
      <div class="row end" style="margin-top:8px"><button class="btn" data-action="paste-import">แยกตอน</button></div>
    </details>
    ${
      pending
        ? `<div class="issues" style="margin-top:12px"><b>พบ ${pending.chapters.length} ตอน</b> (${esc(langByCode(pending.lang).name)}) จาก ${esc(pending.from)}
          <div class="small muted">${pending.chapters.slice(0, 6).map((c) => esc(c.title)).join(" · ")}${pending.chapters.length > 6 ? " · …" : ""}</div>
          ${pending.lang !== p.srcLang ? `<label class="check small" style="margin-top:6px"><input type="checkbox" id="switchLang" checked> เปลี่ยนภาษาต้นฉบับของเรื่องเป็น ${esc(langByCode(pending.lang).name)}</label>` : ""}
          <div class="row" style="margin-top:8px"><button class="btn primary" data-action="confirm-import">เพิ่ม ${pending.chapters.length} ตอน</button><button class="btn" data-action="merge-import">รวมเป็นตอนเดียว</button><button class="btn ghost" data-action="cancel-import">ยกเลิก</button></div></div>`
        : ""
    }
  </div>
  <div class="card">
    <div class="row" style="margin-bottom:10px">
      <h2 class="grow" style="margin:0">ตอนทั้งหมด (${p.chapters.length})</h2>
      ${sel.length ? `<button class="btn" data-action="clear-select">ยกเลิกเลือก</button><button class="btn primary" data-action="translate-selected" ${busy() ? "disabled" : ""}>แปลที่เลือก ${sel.length} ตอน</button>` : ""}
      ${todo.length ? `<button class="btn ${sel.length ? "" : "primary"}" data-action="translate-todo" ${busy() ? "disabled" : ""}>แปลที่ยังไม่แปล (${todo.length})</button>` : ""}
    </div>
    ${todo.length || sel.length ? `<p class="small muted">ประมาณ ${fmt(estimateCalls(p, sel.length ? sel : todo))} ครั้งที่เรียก AI${ai().provider === "gemini" ? ` · Gemini ฟรีได้ราว ${20 * Math.max(1, keyList().length)} ครั้ง/วัน/โมเดล (${Math.max(1, keyList().length)} key) ระบบสลับ key และโมเดลให้เองเมื่อโควตาหมด` : ""}</p>` : ""}
    ${!aiReady() ? `<div class="issues">ยังไม่ได้ตั้งค่า AI · <a href="#" data-action="view" data-view="ai">ตั้งค่าตอนนี้</a> (Gemini ฟรี ใช้เวลา 1 นาที)</div>` : ""}
    ${p.chapters.length ? `<div class="table-wrap"><table><thead><tr><th><input type="checkbox" data-action="select-all" aria-label="เลือกทั้งหมด" ${sel.length === p.chapters.length ? "checked" : ""}></th><th class="hide-sm">#</th><th>ชื่อตอน</th><th class="hide-sm">ความยาว</th><th>สถานะ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">ยังไม่มีตอน</p>`}
  </div>`;
}

afterRender.chapters = () => {
  const drop = $("#drop");
  const fileIn = $("#fileIn");
  fileIn.addEventListener("change", () => importFiles([...fileIn.files]));
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    importFiles([...e.dataTransfer.files]);
  });
};

async function importFiles(list) {
  if (!list.length) return;
  try {
    const chapters = [];
    for (const f of list) {
      for (const part of await files.readFile(f)) {
        if (part.chapter) chapters.push({ title: part.name, text: part.text });
        else chapters.push(...splitChapters(part.text, part.name.replace(/\.[^.]+$/, "")));
      }
    }
    stageImport(chapters, list.map((f) => f.name).join(", "));
  } catch (e) {
    toast(`อ่านไฟล์ไม่ได้: ${e.message}`);
  }
}

function stageImport(chapters, from) {
  if (!chapters.length) return toast("ไม่พบเนื้อหา");
  const lang = detectLang(chapters.map((c) => c.text).join("\n").slice(0, 4000));
  state.pendingImport = { chapters, from, lang };
  render();
}

function confirmImport(merge) {
  const p = state.project;
  const pend = state.pendingImport;
  if ($("#switchLang")?.checked) {
    p.srcLang = pend.lang;
    p.nameStyle = "";
  }
  const list = merge ? [{ title: pend.chapters[0].title, text: pend.chapters.map((c) => c.text).join("\n\n") }] : pend.chapters;
  for (const c of list) p.chapters.push(newChapter(c.title, c.text));
  state.pendingImport = null;
  save();
  render();
  toast(`เพิ่ม ${list.length} ตอนแล้ว`);
}

// ---------------- translation runs ----------------

async function runQueue(ids) {
  if (busy()) return toast("กำลังแปลอยู่");
  const p = state.project;
  if (!aiReady()) return go("ai");
  const queue = ids.map((id) => p.chapters.find((c) => c.id === id)).filter(Boolean);
  if (!queue.length) return;
  const abort = new AbortController();
  const exhausted = exhaustedSet();
  const run = (state.run = { abort, total: queue.length, done: 0, current: "", step: "", log: [], added: 0 });
  const log = (m) => {
    run.log.push(m);
    renderRunner();
  };
  const call = createCaller(aiConfig(), {
    exhausted,
    onWait: (ms, why) => log(`รอ ${Math.ceil(ms / 1000)} วินาที · ${why.slice(0, 80)}`),
    onSwitch: (from, to, reason) => {
      store.prefs.set(`exhausted:${today()}`, [...exhausted]);
      log(`โมเดล ${from} ไม่พร้อม (${reason}) → สลับไปลอง ${to}`);
    },
  });
  const reviewCall = p.review
    ? createCaller(reviewConfig(), { exhausted, onWait: (ms, why) => log(`รอ ${Math.ceil(ms / 1000)} วินาที · ${why.slice(0, 80)}`), onSwitch: () => store.prefs.set(`exhausted:${today()}`, [...exhausted]) })
    : call;
  render();
  const working = new Map();
  const showCurrent = () => (run.current = [...working.values()].join(" · "));
  const tokens = { calls: 0, tokens: 0 };
  const left = new Set(queue.map((c) => c.id));
  store.prefs.set(`run:${p.id}`, [...left]);
  // Android Chrome stops translating when the screen turns off: keep it on during the run. The browser
  // drops the lock whenever the tab is hidden, so take it again when the tab is shown.
  let wake = null;
  let running = true;
  const keepAwake = async () => {
    if (document.visibilityState !== "visible") return;
    const lock = await navigator.wakeLock?.request("screen").catch(() => null);
    if (running) wake = lock;
    else lock?.release().catch(() => {});
  };
  document.addEventListener("visibilitychange", keepAwake);
  await keepAwake();
  const result = await runChapters(p, queue, {
    call,
    reviewCall,
    lanes: Number(ai().parallel) || 1,
    signal: abort.signal,
    onStart: (ch) => {
      working.set(ch.id, ch.titleT || ch.title);
      showCurrent();
      renderRunner();
    },
    onProgress: (ch, e) => {
      if (e.step === "terms") {
        run.added += e.added.length;
        if (e.added.length) log(`${ch.title}: พบคำใหม่ ${e.added.length} คำ (${e.added.slice(0, 5).map((t) => `${t.source}=${t.target}`).join(", ")}${e.added.length > 5 ? " …" : ""})`);
      } else if (e.step === "warn") log(e.message);
      else run.step = stepText(e);
      renderRunner();
    },
    onChapter: async (ch, e) => {
      if (!e) {
        left.delete(ch.id);
        store.prefs.set(`run:${p.id}`, [...left]);
        run.done++;
        run.firstId ??= ch.id;
        tokens.calls += ch.stats?.calls || 0;
        tokens.tokens += ch.stats?.tokens || 0;
        log(`✓ ${ch.titleT || ch.title}`);
      } else if (e.name !== "AbortError") log(`✗ ${ch.title}: ${e.message}`);
      working.delete(ch.id);
      showCurrent();
      // Each chapter is written to the device as soon as it finishes, so a closed tab loses at most the chapters in progress.
      await save(true);
      if (state.view !== "read" && state.view !== "book") render();
    },
  });
  running = false;
  store.prefs.set(`run:${p.id}`, []); // finished or stopped on purpose: nothing to resume
  document.removeEventListener("visibilitychange", keepAwake);
  wake?.release().catch(() => {});
  const stopped = !!result.stopped;
  if (result.stopped === "cancelled") log("หยุดแล้ว");
  if (result.stopped === "failing") {
    const m = "AI ไม่ตอบติดกัน 3 ตอน (ผู้ให้บริการอาจล่ม) จึงหยุดไว้ก่อน ตอนที่เสร็จแล้วเก็บไว้ครบ ลองกด “แปลที่ยังไม่แปล” อีกครั้งภายหลัง";
    log(m);
    toast(m);
  }
  if (tokens.calls) log(`ใช้ AI ${fmt(tokens.calls)} ครั้ง${tokens.tokens ? ` · ${fmt(tokens.tokens)} token` : ""}`);
  run.finished = true;
  run.step = "";
  // Terms found later in the run may occur in chapters translated earlier: check every chapter again.
  const flagged = p.chapters.filter((c) => c.translation && (recheckChapter(p, c)?.ok === false || c.review?.unresolved?.length));
  save(true);
  render();
  if (flagged.length && !stopped && ai().paid) {
    toast(`แปลเสร็จ ${run.done}/${run.total} ตอน`);
    const firstId = run.firstId;
    await fixQueue(flagged);
    if (state.run) state.run.firstId = firstId;
    renderRunner();
    return;
  }
  toast(`แปลเสร็จ ${run.done}/${run.total} ตอน${run.added ? ` · คำใหม่ ${run.added} คำ` : ""}`);
}

// Fix every translated chapter whose check found problems (same as "ให้ AI แก้" on each).
async function fixQueue(chapters) {
  const p = state.project;
  if (busy() || !aiReady()) return aiReady() ? toast("กำลังทำงานอยู่") : go("ai");
  const exhausted = exhaustedSet();
  const run = (state.run = { action: "fix", abort: new AbortController(), total: chapters.length, done: 0, current: "", step: "แก้คำที่เพี้ยน", log: [] });
  const call = createCaller(aiConfig(), {
    exhausted,
    onWait: (ms, why) => (run.log.push(`รอ ${Math.ceil(ms / 1000)} วินาที · ${why.slice(0, 80)}`), renderRunner()),
    onSwitch: (from, to) => (store.prefs.set(`exhausted:${today()}`, [...exhausted]), run.log.push(`สลับ ${from} → ${to}`)),
  });
  for (const c of chapters) {
    run.current = c.titleT || c.title;
    renderRunner();
    try {
      const r = await fixChapter(p, c, { call, signal: run.abort.signal, onProgress: (e) => ((run.step = stepText(e)), renderRunner()) });
      run.done++;
      const n = issueCount(r, c.review);
      run.log.push(`${n ? "เหลือ " + n + " จุด" : "✓"} ${c.titleT || c.title}`);
    } catch (e) {
      run.log.push(`✗ ${c.title}: ${e.message}`);
      if (e.name === "AbortError" || e.kind === "auth" || e.kind === "quota") break;
    }
    save(true);
  }
  run.finished = true;
  const remaining = chapters.filter((c) => issueCount(c.issues, c.review)).length;
  run.log.push(remaining ? `ตรวจเสร็จ · ยังเหลือ ${remaining} ตอนที่มีจุดต้องเช็ก` : `ตรวจผ่านครบ ${run.done} ตอน`);
  render();
}

function stepText(e) {
  const part = e.total > 1 ? ` ท่อน ${e.chunk + 1}/${e.total}` : "";
  return { analyze: "หาชื่อและคำเฉพาะใหม่", translate: `แปล${part}`, review: `AI อีกตัวตรวจเทียบต้นฉบับ${part}`, correct: `แก้ย่อหน้าที่ตรวจพบ${part}`, repair: `แปลย่อหน้าที่ไม่ครบใหม่${part}`, polish: `ขัดเกลา${part}`, fix: `แก้คำที่เพี้ยน${part}`, done: "เสร็จ" }[e.step] || e.step;
}

function renderRunner() {
  const box = $("#runner");
  const run = state.run;
  if (!run) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const pct = Math.round((run.done / run.total) * 100);
  const readBtn = run.firstId && state.view !== "book" ? `<button class="btn sm primary" data-action="read-book" data-id="${run.firstId}">${run.finished ? "อ่านเลย" : "อ่านตอนที่เสร็จแล้ว"}</button>` : "";
  const verb = run.action === "fix" ? "ตรวจ/แก้" : "แปล";
  box.innerHTML = `<div class="row"><b class="grow">${run.finished ? `${verb}เสร็จ ${run.done}/${run.total} ตอน` : `เสร็จ ${run.done}/${run.total} ตอน · ${run.action === "fix" ? "กำลังตรวจ/แก้" : "กำลังแปล"}: ${esc(run.current)}`}</b>
    ${readBtn}${run.finished ? `<button class="btn sm" data-action="close-runner">ปิด</button>` : `<button class="btn sm" data-action="stop">หยุด</button>`}</div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="small">${esc(run.step)}</div>
    <div class="log">${run.log.slice(-6).map(esc).join("\n")}</div>`;
}

// ---------------- reader ----------------

function highlight(text, entries, field, issues) {
  if (!entries.length) return text.split(/\n\s*\n|\n/).filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join("");
  const missIds = new Set((issues?.missing || []).map((m) => m.entry.id));
  const terms = [...entries].filter((e) => e[field]).sort((a, b) => b[field].length - a[field].length);
  const re = new RegExp(terms.map((e) => e[field].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const by = new Map(terms.map((e) => [e[field], e]));
  return text
    .split(/\n\s*\n|\n/)
    .filter(Boolean)
    .map((para) => {
      let out = "";
      let last = 0;
      for (const m of para.matchAll(re)) {
        const e = by.get(m[0]);
        out += esc(para.slice(last, m.index));
        const tip = field === "source" ? `${e.source} → ${e.target}` : `${e.target} ← ${e.source}`;
        out += `<mark class="${field === "target" ? "t" : missIds.has(e.id) ? "miss" : ""}" title="${esc(tip)} · ${esc(typeName(e.type))}">${esc(m[0])}</mark>`;
        last = m.index + m[0].length;
      }
      return `<p>${out}${esc(para.slice(last))}</p>`;
    })
    .join("");
}

function viewRead() {
  const p = state.project;
  if (!p.chapters.length) return `<div class="card"><p>ยังไม่มีตอน</p><button class="btn primary" data-action="view" data-view="chapters">เพิ่มตอน</button></div>`;
  let i = p.chapters.findIndex((c) => c.id === state.chapterId);
  if (i < 0) i = 0;
  const c = p.chapters[i];
  state.chapterId = c.id;
  const used = relevantEntries(p.glossary, c.text);
  const issues = c.issues;
  const issueBox = !c.translation
    ? ""
    : issueCount(issues, c.review)
      ? `<div class="issues"><b>ตรวจพบ ${issueCount(issues, c.review)} จุด</b>
        ${issues.missing.length ? `<div class="small">คำที่ไม่ได้แปลตามอภิธานศัพท์: ${issues.missing.map((m) => `<mark class="miss">${esc(m.entry.source)}</mark> → ต้องเป็น “${esc(m.entry.target)}”`).join(" · ")}</div>` : ""}
        ${issues.leftovers.length ? `<div class="small">ข้อความที่ยังไม่ได้แปล: ${issues.leftovers.map(esc).join(" · ")}</div>` : ""}
        ${issueLines(c).filter((l) => !/^(ชื่อไม่ตรง|ยังไม่ได้แปล):/.test(l)).map((l) => `<div class="small">${esc(l)}</div>`).join("")}
        <div class="row" style="margin-top:6px"><button class="btn sm primary" data-action="fix-chapter" ${busy() ? "disabled" : ""}>ให้ AI แก้</button><button class="btn sm" data-action="recheck">ตรวจใหม่</button></div></div>`
      : `<div class="issues ok small">✓ ชื่อและคำเฉพาะ ${used.length} คำในตอนนี้ แปลตรงตามอภิธานศัพท์ทั้งหมด <button class="btn sm ghost" data-action="recheck">ตรวจใหม่</button></div>`;
  return `
  <div class="row" style="margin-bottom:12px">
    <button class="btn sm" data-action="prev" ${i === 0 ? "disabled" : ""} aria-label="ตอนก่อนหน้า">‹</button>
    <select id="chapterSel" class="grow" style="max-width:420px" aria-label="เลือกตอน">${p.chapters.map((x, j) => `<option value="${x.id}" ${x.id === c.id ? "selected" : ""}>${j + 1}. ${esc(x.titleT || x.title)}</option>`).join("")}</select>
    <button class="btn sm" data-action="next" ${i === p.chapters.length - 1 ? "disabled" : ""} aria-label="ตอนถัดไป">›</button>
    <span class="grow"></span>
    <button class="btn" data-action="translate-one" data-id="${c.id}" ${busy() ? "disabled" : ""}>${c.translation ? "แปลตอนนี้ใหม่" : "แปลตอนนี้"}</button>
  </div>
  ${p.credit || c.models?.length ? `<p class="small muted">${p.credit ? `ต้นฉบับ: ${esc(p.credit)}` : ""}${p.credit && c.models?.length ? " · " : ""}${c.models?.length ? `แปลด้วย ${esc(c.models.join(", "))}` : ""}</p>` : ""}
  ${issueBox}
  ${c.summary ? `<p class="summary"><b>เรื่องย่อตอนนี้</b> (AI ใช้เป็นบริบทของตอนถัดไป): ${esc(c.summary)}</p>` : ""}
  <div class="reader">
    <section class="pane" lang="${p.srcLang}"><div class="pane-head"><span>ต้นฉบับ · ${esc(langByCode(p.srcLang).name)}</span><span>${used.length} คำในอภิธานศัพท์</span></div>
      <h2 style="font-family:inherit">${esc(c.title)}</h2>${highlight(c.text, used, "source", issues)}</section>
    <section class="pane" lang="${p.tgtLang}"><div class="pane-head"><span>คำแปล · ${esc(langByCode(p.tgtLang).name)}</span>
      ${c.translation ? `<button class="btn sm" data-action="toggle-edit">${state.editing ? "เสร็จ" : "แก้ไขเอง"}</button>` : ""}</div>
      ${
        !c.translation
          ? `<p class="muted">ยังไม่ได้แปล</p>`
          : state.editing
            ? `<textarea id="editT" aria-label="แก้คำแปล">${esc(c.translation)}</textarea>`
            : `<h2 style="font-family:inherit">${esc(c.titleT || c.title)}</h2>${highlight(c.translation, used, "target")}`
      }
    </section>
  </div>`;
}

// Full-page reading: translation only, no highlights or source.
// Automatic checks only point at likely mistakes; passing them is not proof the translation is right.
function checkNote(c) {
  const lines = issueLines(c);
  const by = c.review && !c.review.error ? ` และ AI อีกตัว (${esc(c.review.model || "-")})` : "";
  if (!lines.length) return `<p class="small muted">ตรวจอัตโนมัติด้วยโปรแกรม${by}: ไม่พบจุดผิดที่ตรวจได้ · ยังไม่ใช่การตรวจโดยคน</p>`;
  return `<details class="issues small"><summary>ตรวจอัตโนมัติพบ ${lines.length} จุดที่ควรเช็กเทียบต้นฉบับ</summary>${lines.map((l) => `<div>${esc(l)}</div>`).join("")}<div class="muted">ตรวจด้วยโปรแกรม${by} ยังไม่ใช่การตรวจโดยคน</div></details>`;
}

function viewBook() {
  const p = state.project;
  if (!p.chapters.length) return `<div class="card"><p>ยังไม่มีตอน</p><button class="btn primary" data-action="view" data-view="chapters">เพิ่มตอน</button></div>`;
  let i = p.chapters.findIndex((c) => c.id === state.chapterId);
  if (i < 0) i = Math.max(0, p.chapters.findIndex((c) => c.translation));
  const c = p.chapters[i];
  state.chapterId = c.id;
  const nav = (where) => `<nav class="book-nav at-${where}">
    <button class="btn" data-action="prev" ${i === 0 ? "disabled" : ""}>‹ ตอนก่อน</button>
    ${where === "top" ? `<select id="chapterSel" aria-label="เลือกตอน">${p.chapters.map((x, j) => `<option value="${x.id}" ${x.id === c.id ? "selected" : ""}>${j + 1}. ${esc(x.titleT || x.title)}${x.translation ? "" : " (ยังไม่แปล)"}</option>`).join("")}</select>` : `<span class="muted small">${i + 1} / ${p.chapters.length}</span>`}
    <button class="btn" data-action="next" ${i === p.chapters.length - 1 ? "disabled" : ""}>ตอนต่อไป ›</button></nav>`;
  return `
  <article class="book" lang="${p.tgtLang}">
    ${nav("top")}
    <p class="book-kicker">${esc(p.name)} · ตอนที่ ${i + 1}</p>
    <h1>${esc(c.titleT || c.title)}</h1>
    ${c.translation ? highlight(c.translation, [], "target") : `<p class="muted">ตอนนี้ยังไม่ได้แปล</p><button class="btn primary" data-action="translate-one" data-id="${c.id}" ${busy() ? "disabled" : ""}>แปลตอนนี้</button>`}
    ${c.translation ? checkNote(c) : ""}
    ${nav("bottom")}
  </article>`;
}

afterRender.book = () => {
  $("#chapterSel")?.addEventListener("change", (e) => {
    state.chapterId = e.target.value;
    render();
    window.scrollTo({ top: 0 });
  });
};

afterRender.read = () => {
  $("#chapterSel")?.addEventListener("change", (e) => {
    state.chapterId = e.target.value;
    state.editing = false;
    render();
  });
  $("#editT")?.addEventListener("input", (e) => {
    const c = currentChapter();
    c.translation = e.target.value;
    c.edited = true;
    save();
  });
};

const busy = () => !!state.run && !state.run.finished;
const currentChapter = () => state.project.chapters.find((c) => c.id === state.chapterId);

// ---------------- glossary ----------------

function viewGlossary() {
  const p = state.project;
  const f = state.glossFilter;
  const allText = p.chapters.map((c) => c.text).join("\n");
  const counts = countInText(p.glossary, allText);
  const q = f.q.trim().toLowerCase();
  const shown = p.glossary.filter((e) => (!f.type || e.type === f.type) && (!f.status || e.status === f.status) && (!q || `${e.source} ${e.target} ${e.note}`.toLowerCase().includes(q)));
  const pending = p.glossary.filter((e) => e.status === "pending").length;
  const typeOpts = (sel) => TERM_TYPES.map((t) => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${t.name}</option>`).join("");
  return `
  <div class="card">
    <div class="row"><h2 class="grow" style="margin:0">อภิธานศัพท์ (${p.glossary.length} คำ)</h2>
      <label class="btn sm">นำเข้า CSV<input type="file" id="csvIn" accept=".csv,.tsv,.txt" hidden></label>
      <button class="btn sm" data-action="export-csv">ส่งออก CSV</button>
      ${pending ? `<button class="btn sm primary" data-action="approve-all">ยืนยันทั้งหมด (${pending})</button>` : ""}
    </div>
    <p class="small muted" style="margin:.5em 0 0">คำที่ล็อกแล้ว AI ต้องแปลตามนี้ทุกครั้ง · AI หาคำใหม่ให้ทุกตอนที่แปล · แก้คำแปลแล้วจะถามว่าจะเปลี่ยนในตอนที่แปลไปแล้วด้วยไหม · CSV เปิดใน Excel/Google Sheets ได้</p>
  </div>
  <div class="card">
    <h3>เพิ่มคำ</h3>
    <form class="grid3" id="addTerm">
      <label class="field"><span>ต้นฉบับ</span><input type="text" name="source" required lang="${p.srcLang}"></label>
      <label class="field"><span>คำแปลที่ต้องใช้</span><input type="text" name="target" required></label>
      <label class="field"><span>ประเภท</span><select name="type">${typeOpts("person")}</select></label>
      <label class="field"><span>หมายเหตุ (เพศ ฐานะ สรรพนาม)</span><input type="text" name="note"></label>
      <div class="row" style="align-items:flex-end"><button class="btn primary">เพิ่ม</button></div>
    </form>
  </div>
  <div class="card">
    <div class="row" style="margin-bottom:8px">
      <input type="search" id="gq" placeholder="ค้นหา" value="${esc(f.q)}" class="grow" style="max-width:260px" aria-label="ค้นหาคำ">
      <select id="gtype" style="width:auto" aria-label="กรองประเภท"><option value="">ทุกประเภท</option>${typeOpts(f.type)}</select>
      <select id="gstatus" style="width:auto" aria-label="กรองสถานะ"><option value="">ทุกสถานะ</option><option value="locked" ${f.status === "locked" ? "selected" : ""}>ล็อกแล้ว</option><option value="pending" ${f.status === "pending" ? "selected" : ""}>รอยืนยัน</option></select>
    </div>
    ${
      shown.length
        ? `<div class="table-wrap"><table><thead><tr><th>ต้นฉบับ</th><th>คำแปล</th><th>ประเภท</th><th class="hide-sm">หมายเหตุ</th><th class="hide-sm">พบ</th><th></th></tr></thead><tbody>${shown
            .map(
              (e) => `<tr data-id="${e.id}">
          <td><input type="text" data-field="source" value="${esc(e.source)}" lang="${p.srcLang}" aria-label="ต้นฉบับ"></td>
          <td><input type="text" data-field="target" value="${esc(e.target)}" aria-label="คำแปล"></td>
          <td><select data-field="type" aria-label="ประเภท">${typeOpts(e.type)}</select></td>
          <td class="hide-sm"><input type="text" data-field="note" value="${esc(e.note)}" aria-label="หมายเหตุ"></td>
          <td class="muted small hide-sm">${counts.get(e.id) || 0}</td>
          <td class="row" style="flex-wrap:nowrap">${e.status === "pending" ? `<button class="btn sm" data-action="approve" data-id="${e.id}" title="ยืนยันคำนี้">ยืนยัน</button>` : `<span class="badge ok" title="ล็อกแล้ว">ล็อก</span>`}<button class="btn sm ghost danger" data-action="del-term" data-id="${e.id}" aria-label="ลบคำ">ลบ</button></td>
        </tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<p class="muted">${p.glossary.length ? "ไม่พบคำที่ตรงกับตัวกรอง" : "ยังไม่มีคำ แปลตอนแรกแล้ว AI จะเติมให้ หรือเพิ่มเองด้านบน"}</p>`
    }
  </div>`;
}

afterRender.glossary = () => {
  const p = state.project;
  $("#addTerm").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    if (p.glossary.some((x) => x.source === d.source.trim())) return toast("มีคำนี้แล้ว");
    p.glossary.unshift(makeEntry(d));
    p.chapters.forEach((c) => recheckChapter(p, c));
    save();
    render();
    toast("เพิ่มคำแล้ว");
  });
  for (const [id, key] of [["#gq", "q"], ["#gtype", "type"], ["#gstatus", "status"]]) {
    $(id).addEventListener(id === "#gq" ? "input" : "change", (e) => {
      state.glossFilter[key] = e.target.value;
      const pos = e.target.selectionStart;
      render();
      if (id === "#gq") {
        const el = $("#gq");
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }
  main.querySelectorAll("tr[data-id] [data-field]").forEach((el) =>
    el.addEventListener("change", () => {
      const e = p.glossary.find((x) => x.id === el.closest("tr").dataset.id);
      const field = el.dataset.field;
      const old = e[field];
      e[field] = el.value.trim();
      save();
      if (field === "target" && old && old !== e.target) offerReplace(old, e.target);
      if (field === "source" || field === "target") p.chapters.forEach((c) => recheckChapter(p, c));
    }),
  );
  $("#csvIn").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const rows = parseCSV(await f.text());
    let added = 0;
    let updated = 0;
    for (const r of rows) {
      const e = p.glossary.find((x) => x.source === r.source);
      if (e) {
        Object.assign(e, { target: r.target || e.target, type: r.type, note: r.note || e.note, status: "locked" });
        updated++;
      } else {
        p.glossary.push(r);
        added++;
      }
    }
    p.chapters.forEach((c) => recheckChapter(p, c));
    save();
    render();
    toast(`นำเข้าแล้ว: ใหม่ ${added} · อัปเดต ${updated}`);
  });
};

function offerReplace(oldT, newT) {
  const p = state.project;
  const hit = p.chapters.filter((c) => `${c.translation} ${c.summary} ${c.titleT}`.includes(oldT));
  if (!hit.length) return;
  if (!confirm(`เปลี่ยน “${oldT}” เป็น “${newT}” ในคำแปลที่มีอยู่แล้ว ${hit.length} ตอนด้วยไหม?`)) return;
  for (const c of hit) {
    // Summaries feed the next chapters' prompts, so they must use the new name too.
    for (const k of ["translation", "summary", "titleT"]) if (c[k]) c[k] = c[k].split(oldT).join(newT);
    for (const ch of c.chunks || []) ch.out = ch.out.split(oldT).join(newT);
    recheckChapter(p, c);
  }
  save();
  toast(`เปลี่ยนแล้ว ${hit.length} ตอน`);
}

// ---------------- project settings ----------------

function viewSettings() {
  const p = state.project;
  const langOpts = (sel) => LANGS.map((l) => `<option value="${l.code}" ${l.code === sel ? "selected" : ""}>${l.name} (${l.en})</option>`).join("");
  const styles = NAME_STYLES[p.srcLang];
  const size = Number(p.chunkSize) || chunkSizeFor(p.srcLang);
  return `
  <form id="projForm">
  <div class="card">
    <h2>เรื่องนี้</h2>
    <div class="grid2">
      <label class="field"><span>ชื่อเรื่อง</span><input type="text" name="name" value="${esc(p.name)}"></label>
      <label class="field"><span>แนวเรื่อง (กำหนดสำนวนและสรรพนาม)</span><select name="genre">${GENRES.map((g) => `<option value="${g.id}" ${g.id === p.genre ? "selected" : ""}>${g.name}</option>`).join("")}</select></label>
      <label class="field"><span>ภาษาต้นฉบับ</span><select name="srcLang">${langOpts(p.srcLang)}</select></label>
      <label class="field"><span>แปลเป็น</span><select name="tgtLang">${langOpts(p.tgtLang)}</select></label>
      ${styles ? `<label class="field"><span>วิธีเขียนชื่อ</span><select name="nameStyle">${styles.map((s) => `<option value="${s.id}" ${s.id === p.nameStyle ? "selected" : ""}>${s.name}</option>`).join("")}</select></label>` : ""}
    </div>
  </div>
  <div class="card">
    <h2>วิธีแปล</h2>
    <label class="check"><input type="checkbox" name="autoFix" ${p.autoFix ? "checked" : ""}><span><b>ตรวจและแก้ชื่อที่เพี้ยนอัตโนมัติ</b><br><span class="small muted">ถ้าเจอชื่อที่แปลไม่ตรงกับที่ระบบจำไว้ ให้ AI แก้เฉพาะจุดนั้น</span></span></label>
    <label class="check"><input type="checkbox" name="review" ${p.review ? "checked" : ""}><span><b>ให้ AI อีกตัวตรวจเทียบต้นฉบับ</b><br><span class="small muted">หาประโยคที่แปลผิดความหมาย ตกหล่น เติมเอง หรือสลับคนพูด แล้วแก้เฉพาะย่อหน้านั้น ใช้โควตาเพิ่มอย่างน้อย 1 ครั้งต่อท่อน</span></span></label>
    <label class="check"><input type="checkbox" name="polish" ${p.polish ? "checked" : ""}><span><b>ขัดเกลาอีกรอบ</b><br><span class="small muted">ให้ AI อ่านเทียบต้นฉบับแล้วเกลาสำนวน สวยขึ้นแต่ใช้โควตาเป็น 2 เท่า</span></span></label>
    <div class="grid2" style="margin-top:10px">
      <label class="field"><span>ชื่อตัวละคร สถานที่ ที่เจอใหม่</span><select name="autoTerms">
        <option value="auto" ${p.autoTerms === "auto" ? "selected" : ""}>จำชื่อใหม่ให้อัตโนมัติ (แนะนำ)</option>
        <option value="off" ${p.autoTerms === "off" ? "selected" : ""}>ไม่ต้องหา (ประหยัดโควตา)</option></select></label>
    </div>
    <details style="margin-top:10px"><summary class="small muted">ตั้งค่าขั้นสูง</summary>
      <label class="field" style="margin-top:8px"><span>ขนาดท่อนต่อการเรียก AI 1 ครั้ง (ตัวอักษรต้นฉบับ)</span><input type="number" name="chunkSize" min="500" max="20000" step="100" value="${size}"></label>
    </details>
    <label class="field" style="margin-top:10px"><span>คำสั่งเพิ่มเติมถึง AI (ไม่บังคับ)</span><textarea name="custom" placeholder="เช่น พระเอกแทนตัวเองว่า ข้า เรียกนางเอกว่า เจ้า · ไม่ต้องแปลชื่อเมนูอาหาร · ใช้ภาษาวัยรุ่นในบทพูดของน้องสาว">${esc(p.custom)}</textarea></label>
  </div>
  </form>
  <div class="card small muted">แก้แล้วบันทึกอัตโนมัติ · มีผลกับตอนที่แปลหลังจากนี้</div>`;
}

afterRender.settings = () => {
  const form = $("#projForm");
  form.addEventListener("change", () => {
    const p = state.project;
    const d = new FormData(form);
    const srcChanged = d.get("srcLang") !== p.srcLang;
    Object.assign(p, {
      name: d.get("name").trim() || p.name,
      genre: d.get("genre"),
      srcLang: d.get("srcLang"),
      tgtLang: d.get("tgtLang"),
      nameStyle: srcChanged ? "" : d.get("nameStyle") || "",
      autoFix: d.has("autoFix"),
      polish: d.has("polish"),
      review: d.has("review"),
      autoTerms: d.get("autoTerms"),
      chunkSize: Number(d.get("chunkSize")) === chunkSizeFor(p.srcLang) ? 0 : Number(d.get("chunkSize")),
      custom: d.get("custom").trim(),
    });
    save();
    render(); // header shows the name and languages
    toast("บันทึกแล้ว");
  });
};

// ---------------- AI settings ----------------

function viewAI() {
  const a = ai();
  const p = PROVIDERS[a.provider];
  const models = [...new Set([a.model, ...(a.models[a.provider] || p.models)])].filter(Boolean);
  return `
  <div class="card">
    <h2>เลือก AI</h2>
    <div class="providers">${Object.entries(PROVIDERS)
      .map(([id, x]) => `<label class="prov"><input type="radio" name="provider" value="${id}" ${id === a.provider ? "checked" : ""}><b>${esc(x.name)}</b><br><span class="badge ${/ฟรี/.test(x.badge) ? "ok" : ""}">${esc(x.badge)}</span></label>`)
      .join("")}</div>
  </div>
  <div class="card">
    <h2>${esc(p.name)}</h2>
    <p class="small muted">${esc(p.keyHelp)}${p.keyUrl ? ` · <a href="${p.keyUrl}" target="_blank" rel="noopener">เปิดหน้าขอ key ↗</a>` : ""}</p>
    <div class="keys">${keySlots()}</div>
    <p class="small muted" style="margin:6px 0 12px">ใส่ได้สูงสุด ${MAX_KEYS} key (แต่ละ key มีโควตาฟรีของตัวเอง) · ระบบใช้ key สลับกันไป และย้ายไป key ถัดไปเมื่อโควตาของ key ไหนหมด</p>
    <div class="grid2">
      ${a.provider === "custom" ? `<label class="field"><span>Base URL</span><input type="url" id="aiBase" value="${esc(a.base)}" placeholder="http://localhost:11434/v1"></label>` : ""}
      <label class="field"><span>โมเดล</span><div class="row" style="flex-wrap:nowrap"><input type="text" id="aiModel" list="modelList" value="${esc(a.model || p.defaultModel)}"><datalist id="modelList">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist><button class="btn sm" data-action="load-models" type="button">ดึงรายชื่อ</button></div></label>
    </div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="aiFallback" ${a.fallback ? "checked" : ""}><span>สลับไปโมเดลอื่นอัตโนมัติเมื่อโควตาฟรีของโมเดลนี้หมด <span class="small muted">(${esc((aiConfig().fallbackModels || []).join(" → ") || "-")})</span></span></label>
    <div class="row" style="margin-top:12px"><button class="btn primary" data-action="test-ai">ทดสอบการเชื่อมต่อ</button><span id="aiTest" class="small"></span></div>
  </div>
  <div class="card">
    <h2>ความเร็ว</h2>
    <div class="grid2">
      <label class="field"><span>แปลพร้อมกันกี่ตอน</span><select id="aiParallel">${[1, 2, 3, 5, 8].map((n) => `<option value="${n}" ${n === Number(a.parallel) ? "selected" : ""}>${n} ตอน${n === 1 ? " (ทีละตอน)" : ""}</option>`).join("")}</select></label>
    </div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="aiPaid" ${a.paid ? "checked" : ""}><span>key นี้เป็นแบบเสียเงิน ไม่ต้องเว้นระยะรอโควตาฟรี</span></label>
    <p class="small muted" style="margin:8px 0 0">key ฟรี (Gemini ฟรี, Groq) ใช้ 1 ตอน · key เสียเงิน (OpenAI, Claude, Gemini แบบผูกบัตร) ติ๊กช่องนี้แล้วตั้ง 3–5 ตอน จะเร็วขึ้นหลายเท่า · ชื่อที่ระบบจำได้ใช้ร่วมกันทุกตอน ชื่อใหม่ที่เจอจะถูกจำและใช้กับตอนถัดไปทันที</p>
    ${exhaustedSet().size ? `<p class="small muted" style="margin:10px 0 0">โควตาฟรีวันนี้หมดแล้ว: ${esc([...exhaustedSet()].map((k) => k.split("/").slice(1).join("/")).join(", "))} · <a href="#" data-action="reset-quota">ล้าง (ถ้าโควตารีเซ็ตแล้ว)</a></p>` : ""}
  </div>
  <div class="card small muted">key เก็บในเบราว์เซอร์เครื่องนี้เท่านั้น และส่งตรงไปที่ ${esc(p.name)} · ถ้าใช้เครื่องคนอื่น กดล้าง key ก่อนออก <button class="btn sm" data-action="clear-key">ล้าง key ทั้งหมด</button></div>
  ${state.project ? `<div class="row end"><button class="btn" data-action="view" data-view="chapters">กลับไปที่ตอน ›</button></div>` : `<div class="row end"><button class="btn" data-action="home">กลับหน้าแรก ›</button></div>`}`;
}

// The saved keys plus one empty slot, up to MAX_KEYS.
function keySlots() {
  const a = ai();
  const list = keyList(a);
  const n = Math.min(MAX_KEYS, list.length + 1);
  return Array.from({ length: n }, (_, i) =>
    `<label class="field"><span>API key ${i + 1}${a.provider === "custom" ? " (ถ้ามี)" : ""}</span><input type="password" class="aiKey" value="${esc(list[i] || "")}" autocomplete="off" spellcheck="false" placeholder="${i ? "key เพิ่มเติม (ไม่ใส่ก็ได้)" : "วาง key ที่นี่"}"></label>`,
  ).join("");
}

afterRender.ai = () => {
  main.querySelectorAll('input[name="provider"]').forEach((r) =>
    r.addEventListener("change", async () => {
      const a = ai();
      saveAI({ provider: r.value, model: a.models[`last:${r.value}`] || PROVIDERS[r.value].defaultModel });
      render();
    }),
  );
  main.querySelectorAll(".aiKey").forEach((input) =>
    input.addEventListener("change", () => {
      const a = ai();
      const list = [...main.querySelectorAll(".aiKey")].map((i) => i.value.trim()).filter(Boolean);
      saveAI({ keys: { ...a.keys, [a.provider]: list.join("\n") } });
      renderPill();
      render();
    }),
  );
  $("#aiBase")?.addEventListener("change", (e) => saveAI({ base: e.target.value.trim() }));
  $("#aiModel")?.addEventListener("change", (e) => {
    const a = ai();
    saveAI({ model: e.target.value.trim(), models: { ...a.models, [`last:${a.provider}`]: e.target.value.trim() } });
    renderPill();
  });
  $("#aiFallback")?.addEventListener("change", (e) => {
    saveAI({ fallback: e.target.checked });
    render();
  });
  $("#aiParallel")?.addEventListener("change", (e) => saveAI({ parallel: Number(e.target.value) }));
  $("#aiPaid")?.addEventListener("change", (e) => saveAI({ paid: e.target.checked }));
};

async function testAI() {
  const out = $("#aiTest");
  out.textContent = "กำลังทดสอบ…";
  out.style.color = "";
  const c = aiConfig();
  const keys = c.keys.length ? c.keys : [""];
  const lines = [];
  let ok = 0;
  for (const [i, key] of keys.entries()) {
    const who = keys.length > 1 ? `key ${i + 1}: ` : "";
    try {
      const call = createCaller({ ...c, key, keys: [key], fallbackModels: [] }, { maxAttempts: 1 });
      const t0 = Date.now();
      const r = await call({ system: "Translate the user's text into Thai. Output only the translation.", user: "林动握紧了拳头。" });
      lines.push(`✓ ${who}ใช้ได้ (${((Date.now() - t0) / 1000).toFixed(1)} วินาที): “${r.text.trim().slice(0, 60)}”`);
      ok++;
    } catch (e) {
      lines.push(`✗ ${who}${e.message}`);
    }
    out.innerHTML = lines.map(esc).join("<br>") + (i < keys.length - 1 ? "<br>กำลังทดสอบ…" : "");
  }
  out.style.color = ok === keys.length ? "var(--ok)" : ok ? "" : "var(--accent)";
}

async function loadModelList() {
  const out = $("#aiTest");
  out.textContent = "กำลังดึงรายชื่อโมเดล…";
  try {
    const list = await listModels(aiConfig());
    const a = ai();
    saveAI({ models: { ...a.models, [a.provider]: list } });
    render();
    $("#aiTest").textContent = `พบ ${list.length} โมเดล · พิมพ์หรือเลือกในช่องโมเดล`;
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
  }
}

// ---------------- export ----------------

function viewExport() {
  const p = state.project;
  const done = p.chapters.filter((c) => c.translation);
  return `
  <div class="card">
    <h2>ส่งออกคำแปล</h2>
    <p class="muted small">${done.length} จาก ${p.chapters.length} ตอนแปลแล้ว (ส่งออกเฉพาะตอนที่แปลแล้ว เรียงตามลำดับ)</p>
    <div class="row">
      <button class="btn primary" data-action="exp" data-kind="docx" ${done.length ? "" : "disabled"}>Word .docx</button>
      <button class="btn" data-action="exp" data-kind="epub" ${done.length ? "" : "disabled"}>E-book .epub</button>
      <button class="btn" data-action="exp" data-kind="txt" ${done.length ? "" : "disabled"}>.txt รวมเล่ม</button>
      <button class="btn" data-action="exp" data-kind="zip" ${done.length ? "" : "disabled"}>.zip แยกไฟล์ทีละตอน</button>
      <button class="btn" data-action="exp" data-kind="bi" ${done.length ? "" : "disabled"}>.txt ต้นฉบับคู่คำแปล</button>
    </div>
  </div>
  <div class="card">
    <h2>สำรอง / ย้ายเครื่อง</h2>
    <p class="muted small">ไฟล์สำรองมีทุกอย่างของเรื่องนี้ (ต้นฉบับ คำแปล ชื่อที่ระบบจำไว้ การตั้งค่า) แต่ไม่มี API key · ย้ายเครื่องแล้วกด “กู้คืนจากไฟล์สำรอง” ที่หน้าแรก</p>
    <div class="row"><button class="btn" data-action="backup">ดาวน์โหลดไฟล์สำรอง .json</button>
    <label class="btn">กู้คืนจากไฟล์สำรอง<input type="file" id="restoreIn" accept=".json" hidden></label></div>
  </div>`;
}

async function restoreBackup(f) {
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.chapters) || !Array.isArray(data.glossary)) throw new Error("ไม่ใช่ไฟล์สำรองของ Novel Lock");
    const p = { ...blankProject(data.name || "กู้คืน"), ...data, id: `p${Date.now().toString(36)}` };
    resetStuck(p);
    await store.saveProject(p);
    await refreshProjects();
    state.project = p;
    go("chapters");
    toast("กู้คืนแล้ว (เป็นเรื่องใหม่ในรายการ)");
  } catch (err) {
    toast(`กู้คืนไม่ได้: ${err.message}`);
  }
}

const bindRestore = () => $("#restoreIn")?.addEventListener("change", (e) => e.target.files[0] && restoreBackup(e.target.files[0]));
afterRender.export = bindRestore;
afterRender.home = bindRestore;

async function exportAs(kind) {
  const p = state.project;
  const done = p.chapters.filter((c) => c.translation);
  const base = files.safeName(p.name);
  try {
    if (kind === "docx") files.download(`${base}.docx`, await files.toDocx(p.name, done));
    else if (kind === "epub") files.download(`${base}.epub`, await files.toEpub(p.name, done, p.tgtLang));
    else if (kind === "txt") files.download(`${base}.txt`, files.toText(done));
    else if (kind === "md") files.download(`${base}.md`, files.toText(done, { md: true }));
    else if (kind === "bi") files.download(`${base}-bilingual.txt`, files.toText(done, { bilingual: true }));
    else if (kind === "zip") files.download(`${base}.zip`, await files.toZip(done.map((c, i) => [`${String(i + 1).padStart(4, "0")} ${files.safeName(c.titleT || c.title)}.txt`, `${c.titleT || c.title}\n\n${c.translation}\n`])));
  } catch (e) {
    toast(`ส่งออกไม่ได้: ${e.message}`);
  }
}

// ---------------- actions ----------------

const actions = {
  home: () => go("home"),
  view: (el) => go(el.dataset.view),
  open: (el) => openProject(el.dataset.id),
  "new-project": newProjectDialog,
  "delete-project": async (el) => {
    const p = state.projects.find((x) => x.id === el.dataset.id);
    if (!confirm(`ลบ “${p?.name}” ออกจากเครื่องนี้? (กู้คืนไม่ได้ ถ้าไม่ได้สำรองไว้)`)) return;
    await store.deleteProject(el.dataset.id);
    if (state.project?.id === el.dataset.id) state.project = null;
    await refreshProjects();
    render();
  },
  "paste-import": () => {
    const text = $("#pasteIn").value;
    stageImport(splitChapters(text, `ตอนที่ ${state.project.chapters.length + 1}`), "ข้อความที่วาง");
  },
  "confirm-import": () => confirmImport(false),
  "merge-import": () => confirmImport(true),
  "cancel-import": () => {
    state.pendingImport = null;
    render();
  },
  select: (el) => {
    el.checked ? state.selected.add(el.dataset.id) : state.selected.delete(el.dataset.id);
    render();
  },
  "select-all": (el) => {
    state.selected = el.checked ? new Set(state.project.chapters.map((c) => c.id)) : new Set();
    render();
  },
  "clear-select": () => {
    state.selected.clear();
    render();
  },
  "translate-selected": () => runQueue(state.project.chapters.filter((c) => state.selected.has(c.id)).map((c) => c.id)),
  "translate-todo": () => runQueue(state.project.chapters.filter((c) => !c.translation).map((c) => c.id)),
  "translate-one": (el) => {
    const c = state.project.chapters.find((x) => x.id === el.dataset.id);
    if (c.translation && c.edited && !confirm("ตอนนี้มีการแก้คำแปลเอง แปลใหม่จะทับของเดิม ทำต่อไหม?")) return;
    runQueue([el.dataset.id]);
  },
  "delete-chapter": (el) => {
    const p = state.project;
    const c = p.chapters.find((x) => x.id === el.dataset.id);
    if (!confirm(`ลบตอน “${c.title}”?`)) return;
    p.chapters = p.chapters.filter((x) => x !== c);
    state.selected.delete(c.id);
    save();
    render();
  },
  read: (el) => {
    state.chapterId = el.dataset.id;
    go("read");
  },
  "read-book": (el) => {
    state.chapterId = el.dataset.id;
    go("book");
  },
  prev: () => step(-1),
  next: () => step(1),
  "toggle-edit": () => {
    state.editing = !state.editing;
    if (!state.editing) recheckChapter(state.project, currentChapter());
    save();
    render();
  },
  recheck: () => {
    recheckChapter(state.project, currentChapter());
    save();
    render();
    toast("ตรวจแล้ว");
  },
  "fix-chapter": async () => {
    if (busy() || !aiReady()) return;
    const c = currentChapter();
    const run = (state.run = { action: "fix", abort: new AbortController(), total: 1, done: 0, current: c.titleT || c.title, step: "แก้คำที่เพี้ยน", log: [] });
    renderRunner();
    try {
      const exhausted = exhaustedSet();
      await fixChapter(state.project, c, { call: createCaller(aiConfig(), { exhausted, onWait: (ms, why) => run.log.push(`รอ ${Math.ceil(ms / 1000)} วินาที · ${why}`) }), signal: run.abort.signal });
      run.done = 1;
      run.log.push(c.issues.ok ? "✓ แก้ครบแล้ว" : "ยังเหลือบางจุด ลองแก้เองในโหมดแก้ไข");
    } catch (e) {
      run.log.push(`✗ ${e.message}`);
    }
    run.finished = true;
    save(true);
    render();
  },
  approve: (el) => {
    state.project.glossary.find((e) => e.id === el.dataset.id).status = "locked";
    save();
    render();
  },
  "approve-all": () => {
    state.project.glossary.forEach((e) => (e.status = "locked"));
    save();
    render();
  },
  "del-term": (el) => {
    const p = state.project;
    p.glossary = p.glossary.filter((e) => e.id !== el.dataset.id);
    p.chapters.forEach((c) => recheckChapter(p, c));
    save();
    render();
  },
  "export-csv": () => files.download(`${files.safeName(state.project.name)}-glossary.csv`, toCSV(state.project.glossary), "text/csv;charset=utf-8"),
  exp: (el) => exportAs(el.dataset.kind),
  backup: () => files.download(`${files.safeName(state.project.name)}-backup.json`, JSON.stringify(state.project), "application/json"),
  "test-ai": testAI,
  "load-models": loadModelList,
  "clear-key": () => {
    const a = ai();
    saveAI({ keys: { ...a.keys, [a.provider]: "" } });
    render();
    toast("ล้าง key แล้ว");
  },
  "reset-quota": () => {
    store.prefs.set(`exhausted:${today()}`, []);
    render();
  },
  stop: () => state.run?.abort.abort(),
  "close-runner": () => {
    state.run = null;
    render();
  },
};

function step(d) {
  const p = state.project;
  const i = p.chapters.findIndex((c) => c.id === state.chapterId);
  const n = p.chapters[i + d];
  if (!n) return;
  state.chapterId = n.id;
  state.editing = false;
  render();
  window.scrollTo({ top: 0 });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName === "A" || el.tagName === "BUTTON") e.preventDefault();
  fn(el, e);
});

window.addEventListener("popstate", async (e) => {
  const h = e.state;
  if (!h) return;
  if (h.project && h.project !== state.project?.id) {
    const p = await store.getProject(h.project);
    if (p) {
      resetStuck(p);
      state.project = p;
      state.selected = new Set();
    }
  }
  if (h.chapter) state.chapterId = h.chapter;
  go(h.view, { fromHistory: true });
});

window.addEventListener("beforeunload", (e) => {
  if (state.run && !state.run.finished) e.preventDefault();
});

// ---------------- start ----------------

(async function start() {
  await refreshProjects();
  const last = store.prefs.get("last", null);
  if (last && state.projects.some((p) => p.id === last)) await openProject(last);
  else go("home");
})();
