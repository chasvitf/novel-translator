// Projects live in IndexedDB on this device; API keys and preferences in localStorage.

const DB = "novel-lock";
const STORE = "projects";
let dbp = null;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const listProjects = () => tx("readonly", (s) => s.getAll());
export const getProject = (id) => tx("readonly", (s) => s.get(id));
export const deleteProject = (id) => tx("readwrite", (s) => s.delete(id));
// Each save bumps `rev`. A save whose rev does not match the stored one was loaded before another tab
// saved the same story; writing it would wipe that tab's chapters, so it is refused instead.
export async function saveProject(p) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, "readwrite");
    const s = t.objectStore(STORE);
    let conflict = false;
    let bumped = false;
    s.get(p.id).onsuccess = (e) => {
      const stored = e.target.result;
      if (stored && (stored.rev || 0) !== (p.rev || 0)) {
        conflict = true;
        return t.abort();
      }
      p.rev = (p.rev || 0) + 1;
      bumped = true;
      p.updatedAt = Date.now();
      // Drop the pre-fix drafts kept in memory for test scripts: a quarter of a 1,000-chapter project.
      s.put(JSON.parse(JSON.stringify(p, (k, v) => (k === "draft" ? undefined : v))));
    };
    t.oncomplete = () => resolve();
    t.onabort = t.onerror = () => {
      // A failed write (disk full) must not make every later save look like a conflict; error and abort both fire.
      if (bumped) {
        p.rev--;
        bumped = false;
      }
      reject(conflict ? new Error("เรื่องนี้ถูกแก้จากแท็บหรือหน้าต่างอื่น ปิดแท็บอื่นแล้วโหลดหน้านี้ใหม่") : t.error);
    };
  });
}

export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`nl:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`nl:${key}`, JSON.stringify(value));
    } catch {
      /* private mode: keep going without saving */
    }
  },
};
