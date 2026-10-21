// "Bibliotecas" con la misma interfaz en dos versiones:
//  - local: en el navegador (sin cuenta)
//  - cloud: en Netlify Blobs a través de la API (con cuenta)
// Contratos, plantillas y perfil (tu marca).
import { api, store, ApiError } from "./util.js";
import { countSignatures } from "../shared/integrity.mjs";

export class ConflictError extends Error {
  constructor(latest) {
    super("conflict");
    this.latest = latest;
  }
}

const LIST_KEY = "laceyLegal.history.v1";
const VKEY = (id) => `laceyLegal.versions.v1.${id}`;
const TPL_KEY = "laceyLegal.templates.v1";
const PROFILE_KEY = "laceyLegal.profile.v1";
const MAX_LOCAL = 80;
const MAX_LOCAL_VERSIONS = 12;

const meta = (c) => ({
  id: c.id, title: c.title, lang: c.lang, folder: c.folder || "", updated: c.updated, created: c.created || c.updated,
  endDate: c.endDate || "", remindDays: c.remindDays ?? 7, remindEmail: !!c.remindEmail,
  sigCount: countSignatures(c.html), openComments: 0, shares: [],
});

// ───────────────────────── contratos ─────────────────────────
export const localLib = {
  kind: "local",
  all() {
    return store.get(LIST_KEY, []);
  },
  async list() {
    return this.all().map(meta);
  },
  async get(id) {
    return this.all().find((x) => x.id === id) || null;
  },
  async save(c, { version, base, force } = {}) {
    const list = this.all();
    const i = list.findIndex((x) => x.id === c.id);
    const existing = i >= 0 ? list[i] : null;
    if (existing && base != null && existing.updated !== base && !force) throw new ConflictError(existing);
    const { audit, comments, auditEvent, ...clean } = c; // eslint-disable-line no-unused-vars
    const entry = {
      ...existing, ...clean,
      folder: existing ? existing.folder || "" : c.folder || "",
      created: existing?.created || Date.now(),
      updated: Math.max(Date.now(), (existing?.updated || 0) + 1),
    };
    if (i >= 0) list.splice(i, 1);
    list.unshift(entry);
    if (!store.set(LIST_KEY, list.slice(0, MAX_LOCAL))) throw new Error("storage-full");
    const label = version || (existing ? "" : "Creado");
    if (label) {
      const vs = store.get(VKEY(c.id), []);
      vs.unshift({ id: String(Date.now()), at: entry.updated, label, html: entry.html });
      store.set(VKEY(c.id), vs.slice(0, MAX_LOCAL_VERSIONS)) || store.set(VKEY(c.id), vs.slice(0, 3));
    }
    return { updated: entry.updated };
  },
  async setFolder(id, folder) {
    const list = this.all();
    const c = list.find((x) => x.id === id);
    if (c) {
      c.folder = folder;
      store.set(LIST_KEY, list);
    }
  },
  async remove(id) {
    store.set(LIST_KEY, this.all().filter((x) => x.id !== id));
    store.remove(VKEY(id));
  },
  async versions(id) {
    return store.get(VKEY(id), []).map(({ id, at, label }) => ({ id, at, label }));
  },
  async version(id, vid) {
    return store.get(VKEY(id), []).find((v) => v.id === vid) || null;
  },
  clear() {
    this.all().forEach((c) => store.remove(VKEY(c.id)));
    store.remove(LIST_KEY);
  },
};

export const cloudLib = {
  kind: "cloud",
  async list() {
    return (await api("/api/contracts")).items;
  },
  async get(id) {
    try {
      return await api(`/api/contracts/${id}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },
  async save(c, { version, base, force } = {}) {
    try {
      return await api(`/api/contracts/${c.id}`, {
        method: "PUT",
        body: {
          title: c.title, html: c.html, lang: c.lang, folder: c.folder || "", endDate: c.endDate || "",
          remindDays: c.remindDays ?? 7, remindEmail: !!c.remindEmail, version, base, force, auditEvent: c.auditEvent,
        },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.latest) throw new ConflictError(err.data.latest);
      throw err;
    }
  },
  setFolder: (id, folder) => api(`/api/contracts/${id}`, { method: "PATCH", body: { folder } }),
  async remove(id) {
    await api(`/api/contracts/${id}`, { method: "DELETE" });
  },
  versions: (id) => api(`/api/contracts/${id}/versions`),
  version: (id, vid) => api(`/api/contracts/${id}/versions/${vid}`),
  comment: (id, commentId, patch) => api(`/api/contracts/${id}/comments/${commentId}`, { method: "PATCH", body: patch }),
};

// ───────────────────────── plantillas ─────────────────────────
export function templateFields(html) {
  const text = String(html).replace(/<[^>]+>/g, " ");
  const seen = new Set();
  for (const m of text.matchAll(/\{([^{}<>]{1,40})\}/g)) {
    const f = m[1].trim();
    if (f) seen.add(f);
  }
  return [...seen].slice(0, 40);
}

export const localTemplates = {
  all: () => store.get(TPL_KEY, []),
  async list() {
    return this.all().map(({ id, name, fields, updated }) => ({ id, name, fields, updated }));
  },
  async get(id) {
    return this.all().find((x) => x.id === id) || null;
  },
  async save(id, { name, html }) {
    const list = this.all().filter((x) => x.id !== id);
    list.unshift({ id, name, html, fields: templateFields(html), updated: Date.now() });
    if (!store.set(TPL_KEY, list.slice(0, 40))) throw new Error("storage-full");
  },
  async remove(id) {
    store.set(TPL_KEY, this.all().filter((x) => x.id !== id));
  },
};

export const cloudTemplates = {
  list: () => api("/api/templates"),
  async get(id) {
    try { return await api(`/api/templates/${id}`); } catch (err) { if (err.status === 404) return null; throw err; }
  },
  save: (id, { name, html }) => api(`/api/templates/${id}`, { method: "PUT", body: { name, html } }),
  remove: (id) => api(`/api/templates/${id}`, { method: "DELETE" }),
};

// ───────────────────────── perfil (tu marca) ─────────────────────────
export const localProfile = {
  get: async () => store.get(PROFILE_KEY, {}),
  async save(p) {
    if (!store.set(PROFILE_KEY, p)) throw new Error("storage-full");
    return p;
  },
};

export const cloudProfile = {
  get: () => api("/api/profile"),
  save: (p) => api("/api/profile", { method: "PUT", body: p }),
};
