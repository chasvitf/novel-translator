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
export function saveProject(p) {
  p.updatedAt = Date.now();
  // Structured clone drops nothing we need; strip transient fields.
  return tx("readwrite", (s) => s.put(JSON.parse(JSON.stringify(p))));
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
