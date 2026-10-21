// Utilidades HTTP compartidas por las funciones.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export async function readJSON(req, maxBytes = 1_000_000) {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "El contenido es demasiado grande.");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

export const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Bloquea llamadas desde otros sitios (el navegador siempre manda Origin en POST/PUT/DELETE). */
export function checkOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const self = new URL(req.url).origin;
  if (origin !== self) throw new HttpError(403, "Origen no permitido.");
}

/** Envuelve un handler y convierte errores en respuestas JSON. */
export const wrap = (fn) => async (req, context) => {
  try {
    return await fn(req, context);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, ...(err.extra || {}) }, err.status);
    console.error(err);
    return json({ error: "Algo salió mal en el servidor. Intentá de nuevo." }, 500);
  }
};

export const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const env = (name) =>
  (globalThis.Netlify?.env?.get?.(name)) ?? process.env[name];
