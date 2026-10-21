// Acceso a Netlify Blobs.
//
// Claves:
//   users/{uid}/index        { email, name, items: [meta] }
//   users/{uid}/c/{cid}      { id, title, html, lang, folder, updated, created, endDate, remindDays, remindEmail }
//   users/{uid}/v/{cid}      [ { id, at, label, html } ]                (máx. MAX_VERSIONS)
//   users/{uid}/log/{cid}    { audit: [evento], comments: [comentario] }  (no cambia "updated" del contrato)
//   users/{uid}/templates    [ { id, name, html, fields, updated } ]
//   users/{uid}/profile      { name, idNumber, address, email, phone, logo, useAsPartyA, brandExports }
//   shares/{token}           { uid, cid, group, order, ordered, signerName, role, email, ownerName, status, ... }
//   usage/{día}/{clave}      { n }
//   i18n/{lang}/{hash}       [ "cadena traducida", ... ]

import { getStore } from "@netlify/blobs";
import { countSignatures } from "../../shared/integrity.mjs";

export const MAX_VERSIONS = 30;
export const MAX_CONTRACTS = 300;
export const MAX_TEMPLATES = 60;
export const MAX_AUDIT = 200;
export const MAX_COMMENTS = 100;

export const openStore = () => getStore({ name: "lacey-legal", consistency: "strong" });

const k = {
  index: (uid) => `users/${uid}/index`,
  contract: (uid, cid) => `users/${uid}/c/${cid}`,
  versions: (uid, cid) => `users/${uid}/v/${cid}`,
  log: (uid, cid) => `users/${uid}/log/${cid}`,
  templates: (uid) => `users/${uid}/templates`,
  profile: (uid) => `users/${uid}/profile`,
  share: (token) => `shares/${token}`,
  usage: (day, key) => `usage/${day}/${key}`,
};
export const keys = k;

export const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const TOKEN_RE = /^[a-f0-9]{48}$/;
export const newToken = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

// ───── índice y contratos ─────
export async function getIndex(store, uid) {
  return (await store.get(k.index(uid), { type: "json" })) || { items: [] };
}
export const putIndex = (store, uid, index) => store.setJSON(k.index(uid), index);

export const getContract = (store, uid, cid) => store.get(k.contract(uid, cid), { type: "json" });

export async function getVersions(store, uid, cid) {
  return (await store.get(k.versions(uid, cid), { type: "json" })) || [];
}

export function metaOf(contract, prev = {}) {
  return {
    id: contract.id,
    title: contract.title,
    lang: contract.lang,
    folder: contract.folder || "",
    updated: contract.updated,
    created: contract.created || contract.updated,
    endDate: contract.endDate || "",
    remindDays: contract.remindDays ?? 7,
    remindEmail: !!contract.remindEmail,
    remindedFor: prev.endDate === contract.endDate ? prev.remindedFor || "" : "",
    sigCount: countSignatures(contract.html),
    openComments: prev.openComments || 0,
    shares: prev.shares || [],
  };
}

/** Guarda un contrato, actualiza el índice y (opcional) agrega una versión. */
export async function saveContract(store, uid, contract, { versionLabel, user } = {}) {
  await store.setJSON(k.contract(uid, contract.id), contract);

  if (versionLabel) {
    const versions = await getVersions(store, uid, contract.id);
    versions.unshift({ id: crypto.randomUUID(), at: contract.updated, label: versionLabel, html: contract.html });
    await store.setJSON(k.versions(uid, contract.id), versions.slice(0, MAX_VERSIONS));
  }

  const index = await getIndex(store, uid);
  if (user) {
    index.email = user.email || index.email || "";
    index.name = user.name || index.name || "";
  }
  const i = index.items.findIndex((x) => x.id === contract.id);
  const prev = i >= 0 ? index.items.splice(i, 1)[0] : {};
  index.items.unshift(metaOf(contract, prev));
  await putIndex(store, uid, index);
  return index;
}

export async function deleteContract(store, uid, cid) {
  const index = await getIndex(store, uid);
  const meta = index.items.find((x) => x.id === cid);
  for (const s of meta?.shares || []) await store.delete(k.share(s.token));
  await store.delete(k.contract(uid, cid));
  await store.delete(k.versions(uid, cid));
  await store.delete(k.log(uid, cid));
  index.items = index.items.filter((x) => x.id !== cid);
  await putIndex(store, uid, index);
}

export async function patchMeta(store, uid, cid, fn) {
  const index = await getIndex(store, uid);
  const meta = index.items.find((x) => x.id === cid);
  if (!meta) return null;
  fn(meta);
  await putIndex(store, uid, index);
  return meta;
}

export function updateShareMeta(store, uid, cid, token, patch) {
  return patchMeta(store, uid, cid, (meta) => {
    meta.shares = meta.shares || [];
    const s = meta.shares.find((x) => x.token === token);
    if (s) Object.assign(s, patch);
    else meta.shares.push({ token, ...patch });
  });
}

// ───── registro: auditoría y comentarios ─────
export async function getLog(store, uid, cid) {
  const log = (await store.get(k.log(uid, cid), { type: "json" })) || {};
  return { audit: log.audit || [], comments: log.comments || [] };
}

export async function updateLog(store, uid, cid, fn) {
  const log = await getLog(store, uid, cid);
  fn(log);
  log.audit = log.audit.slice(-MAX_AUDIT);
  log.comments = log.comments.slice(-MAX_COMMENTS);
  await store.setJSON(k.log(uid, cid), log);
  return log;
}

export const addAudit = (store, uid, cid, event) =>
  updateLog(store, uid, cid, (log) => log.audit.push({ at: Date.now(), ...event }));

/** IP de quien hace la petición (Netlify la manda en el contexto o en un encabezado). */
export const clientIP = (req, context) =>
  context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";

export const userAgent = (req) => (req.headers.get("user-agent") || "").slice(0, 200);

// ───── plantillas y perfil ─────
export async function getTemplates(store, uid) {
  return (await store.get(k.templates(uid), { type: "json" })) || [];
}
export const putTemplates = (store, uid, list) => store.setJSON(k.templates(uid), list.slice(0, MAX_TEMPLATES));

export async function getProfile(store, uid) {
  return (await store.get(k.profile(uid), { type: "json" })) || {};
}
export const putProfile = (store, uid, profile) => store.setJSON(k.profile(uid), profile);

// ───── borrar todo ─────
export async function deleteUserData(store, uid) {
  const index = await getIndex(store, uid);
  for (const item of index.items) for (const s of item.shares || []) await store.delete(k.share(s.token));
  const { blobs } = await store.list({ prefix: `users/${uid}/` });
  for (const b of blobs) await store.delete(b.key);
}

// ───── uso diario de la IA ─────
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export async function getUsage(store, key, now) {
  return (await store.get(k.usage(today(now), key), { type: "json" }))?.n || 0;
}

export async function addUsage(store, key, now) {
  const n = (await getUsage(store, key, now)) + 1;
  await store.setJSON(k.usage(today(now), key), { n });
  return n;
}
