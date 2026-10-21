// Utilidades del navegador compartidas.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

let toastTimer;
export function toast(msg, isError = false) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 5500 : 3000);
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("No hay conexión. Revisá tu internet.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status, data);
  return data;
}

export const ai = (payload) => api("/api/ai", { method: "POST", body: payload }).then((d) => d.result);

// Deja pasar solo etiquetas seguras (la IA y los links compartidos devuelven HTML).
const ALLOWED = new Set(["H1", "H2", "H3", "H4", "P", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "U", "BR", "HR",
  "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "DIV", "SPAN", "IMG", "SECTION"]);
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON",
  "SVG", "MATH", "TEXTAREA", "SELECT", "TEMPLATE", "NOSCRIPT"]);
const CLASS_RE = /^(signatures|sig-block|sig-line|sig-meta)$/;

export function sanitize(html) {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstChild;
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.COMMENT_NODE) return child.remove();
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const tag = child.tagName;
      if (DROP.has(tag)) return child.remove();
      if (!ALLOWED.has(tag)) {
        walk(child);
        child.replaceWith(...child.childNodes);
        return;
      }
      [...child.attributes].forEach((a) => {
        const keep =
          (tag === "IMG" && a.name === "src" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(a.value)) ||
          (tag === "IMG" && a.name === "alt") ||
          (a.name === "class" && CLASS_RE.test(a.value));
        if (!keep) child.removeAttribute(a.name);
      });
      if (tag === "IMG" && !child.getAttribute("src")) return child.remove();
      walk(child);
    });
  };
  walk(root);
  return root.innerHTML;
}

/** Solo <em>, <strong> y <br> (para textos de la interfaz traducidos). */
export function sanitizeInline(html) {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstChild;
  const walk = (node) => [...node.childNodes].forEach((c) => {
    if (c.nodeType === Node.COMMENT_NODE) return c.remove();
    if (c.nodeType !== Node.ELEMENT_NODE) return;
    walk(c);
    if (["EM", "STRONG", "BR"].includes(c.tagName)) [...c.attributes].forEach((a) => c.removeAttribute(a.name));
    else c.replaceWith(...c.childNodes);
  });
  walk(root);
  return root.innerHTML;
}

export const cleanAIHtml = (text) => String(text).replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36));

export function slugify(s, fallback = "contrato") {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || fallback;
}

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* sin acceso */ }
  },
};

export function daysLeft(endDate, now = new Date()) {
  if (!endDate) return null;
  const [y, m, d] = endDate.split("-").map(Number);
  const end = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end - today) / 86400000);
}

/** Abre/cierra <dialog> con fallback. */
export const openDialog = (d) => (d.showModal ? d.showModal() : d.setAttribute("open", ""));
export const closeDialog = (d) => (d.close ? d.close() : d.removeAttribute("open"));
