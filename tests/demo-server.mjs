// Servidor de DEMO local: sirve public/, imita Netlify Identity y conecta /api/* a las funciones
// con datos en memoria e IA SIMULADA (respuestas de ejemplo, no usa Gemini).
// Uso: npm run demo  →  http://localhost:8777
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// En la demo el límite diario de IA es alto (se puede cambiar con las variables de entorno).
process.env.AI_DAILY_LIMIT ||= "500";
process.env.AI_DAILY_LIMIT_ANON ||= "300";
const { makeHandler: contracts } = await import(ROOT + "/netlify/functions/contracts.mjs");
const { makeHandler: share } = await import(ROOT + "/netlify/functions/share.mjs");
const { makeHandler: sign } = await import(ROOT + "/netlify/functions/sign.mjs");
const { makeHandler: aiFn } = await import(ROOT + "/netlify/functions/ai.mjs");
const { makeHandler: templatesFn } = await import(ROOT + "/netlify/functions/templates.mjs");
const { makeHandler: profileFn } = await import(ROOT + "/netlify/functions/profile.mjs");
const noMail = async () => ({ ok: true, text: async () => "" });

const mem = new Map();
const store = {
  async get(k, o) { if (!mem.has(k)) return null; const v = mem.get(k); return o?.type === "json" ? JSON.parse(v) : v; },
  async setJSON(k, v) { mem.set(k, JSON.stringify(v)); },
  async delete(k) { mem.delete(k); },
  async list({ prefix = "" } = {}) { return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
};
export const aiCalls = [];

// ── IA simulada ──
const SIGS = `<h2>Firmas</h2><div class="signatures"><div class="sig-block"><p class="sig-line">Sofía Méndez</p><p class="sig-meta">Prestadora del servicio · Fecha: [__________]</p></div>` +
  `<div class="sig-block"><p class="sig-line">Café Rosa S.A.</p><p class="sig-meta">Cliente · Fecha: [__________]</p></div></div>`;
const CONTRACT = (title) => `<h1>${title}</h1><p>Entre <strong>Sofía Méndez</strong> y <strong>Café Rosa S.A.</strong> se celebra el presente contrato.</p>
<h2>Primera: Objeto</h2><p>La prestadora diseñará la identidad de marca del cliente, incluyendo logotipo y paleta de colores.</p>
<h2>Segunda: Precio</h2><p>El cliente pagará 800 USD en dos tractos iguales.</p><ol><li>Primer pago al firmar.</li><li>Segundo pago a la entrega.</li></ol>
<script>alert(1)</script><p onclick="x()">Texto con atributo peligroso.</p>` + SIGS;
// Simula la respuesta en vivo: entrega el texto en pedacitos.
async function fakeStream(opts) {
  const full = String(await fakeAI(opts));
  return (async function* () {
    for (let i = 0; i < full.length; i += 120) {
      await new Promise((r) => setTimeout(r, 15));
      yield full.slice(i, i + 120);
    }
  })();
}

async function fakeAI({ system, parts, json }) {
  const text = parts.map((p) => p.text || "").join("\n");
  aiCalls.push({ system: system.slice(0, 60), text: text.slice(0, 200), hasFile: parts.some((p) => p.inlineData) });
  if (Array.isArray(json?.items ? [] : null) || json?.type === "ARRAY") {
    return JSON.parse(parts[0].text).map(({ i, s }) => ({ i, t: s.includes("{") || s.includes("<") ? s : "EN: " + s }));
  }
  if (json && system.includes("Sos Lacey")) {
    const q = text.split("Usuaria:").pop().toLowerCase();
    if (q.includes("firmar")) return { reply: "Para mandarlo a firmar:\n\n- Iniciá sesión\n- Tocá **Enviar a firmar** y compartí el link", mood: "feliz", actions: ["share"] };
    if (q.includes("falta")) return { reply: "Le falta una cláusula de propiedad intelectual. Te recomiendo revisarlo con IA para agregarla con un clic.", mood: "preocupada", actions: ["review"] };
    return { reply: "Tu contrato dice que el cliente paga 800 USD en dos partes: una al firmar y otra a la entrega. Es un acuerdo de diseño de marca entre Sofía y Café Rosa.", mood: "pensando", actions: [] };
  }
  if (json && system.includes("abogada revisora")) {
    return { score: 72, summary: "Buen borrador, pero le faltan detalles.", plain: "Una diseñadora hace tu marca y le pagás en dos partes.",
      missing: [{ title: "Propiedad intelectual", why: "No dice quién es dueño del logo." }],
      risks: [{ level: "alta", issue: "No hay fecha de entrega", suggestion: "Agregá un plazo concreto." }, { level: "baja", issue: "Moneda", suggestion: "Aclarar tipo de cambio." }] };
  }
  if (json) {
    return { title: "Contrato de alquiler", kind: "Arrendamiento", parties: ["Arrendador: Juan", "Arrendataria: vos"], summary: "Alquilás un apartamento por un año.",
      keyPoints: ["Pagás el 1 de cada mes"], dates: ["Inicio: 1 de enero"], money: ["$500 al mes", "Depósito $1000"],
      redFlags: [{ level: "alta", issue: "Multa del 50% por salir antes", why: "Es muy alta." }], questions: ["¿Me devuelven el depósito?"], isContract: true };
  }
  // Simula un contrato que llega cortado: la continuación trae lo que faltaba.
  if (system.includes("quedó cortado")) return "<h2>Tercera: Plazo</h2><p>La entrega será en 30 días.</p>" + SIGS;
  if (system.includes("experta en redactar") && text.includes("CORTADO")) return CONTRACT("Contrato de Diseño").split("<h2>Firmas</h2>")[0] + "<p>La prestadora se comp";
  if (system.includes("plantilla reutilizable")) {
    return parts[0].text.replace(/Sofía Méndez/g, "{nombre de la prestadora}").replace(/Café Rosa S\.A\./g, "{nombre del cliente}").replace(/800 USD/g, "{monto}");
  }
  if (system.includes("UNA cláusula")) return "<h2>Propiedad intelectual</h2><p>Los derechos del logotipo pasan al cliente al pagar el total.</p>";
  if (system.includes("Traducí el siguiente contrato")) return parts[0].text.replace(/Contrato de Diseño/g, "Design Agreement").replace(/Primera: Objeto/g, "First: Purpose");
  if (system.includes("Editás fragmentos")) return "TEXTO EDITADO POR IA";
  return CONTRACT("Contrato de Diseño");
}

// ── Identity simulada ──
const users = new Map(); // email → {id, password, user}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtFor = (u) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600, user_metadata: u.user_metadata, app_metadata: u.app_metadata })}.sig`;
const userFromJwt = (jwt) => {
  try { const p = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()); return [...users.values()].find((x) => x.user.id === p.sub)?.user || null; } catch { return null; }
};
function cookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
let currentNodeReq = null;
const getUser = async () => {
  const u = userFromJwt(cookie(currentNodeReq, "nf_jwt") || "");
  return u ? { id: u.id, email: u.email, name: u.user_metadata?.full_name } : null;
};

async function identity(req, res, path, body) {
  const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(data == null ? "" : JSON.stringify(data)); };
  if (path === "/settings") return send(200, { autoconfirm: true, disable_signup: false, external: { google: true, email: true } });
  if (path === "/signup" && req.method === "POST") {
    const { email, password, data } = JSON.parse(body);
    if (users.has(email)) return send(400, { msg: "A user with this email address has already been registered" });
    const user = { id: "u-" + Math.random().toString(36).slice(2, 10), aud: "", role: "", email, confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), app_metadata: { provider: "email" }, user_metadata: data || {} };
    users.set(email, { password, user });
    return send(200, user);
  }
  if (path === "/token" && req.method === "POST") {
    const p = new URLSearchParams(body);
    const u = users.get(p.get("username"));
    if (!u || u.password !== p.get("password")) return send(400, { error: "invalid_grant", error_description: "Invalid email or password" });
    return send(200, { access_token: jwtFor(u.user), token_type: "bearer", expires_in: 3600, refresh_token: "refresh-" + u.user.id });
  }
  if (path === "/user") {
    const u = userFromJwt((req.headers.authorization || "").replace(/^Bearer /, ""));
    return u ? send(200, u) : send(401, { msg: "Invalid token" });
  }
  if (path === "/logout") return send(204, null);
  if (path === "/recover") return send(200, {});
  return send(404, { msg: "not found " + path });
}

// ── rutas de funciones ──
const routes = [
  [/^\/api\/contracts(?:\/([^/]+))?(?:\/versions(?:\/([^/]+))?)?(?:\/comments\/([^/]+))?$/, contracts({ store: () => store, getUser }), (m) => ({ id: m[1], vid: m[2], commentId: m[3] })],
  [/^\/api\/share(?:\/([^/]+))?(?:\/remind)?$/, share({ store: () => store, getUser, fetchImpl: noMail }), (m) => ({ token: m[1] })],
  [/^\/api\/sign\/([^/]+)(?:\/comment)?$/, sign({ store: () => store, fetchImpl: noMail }), (m) => ({ token: m[1] })],
  [/^\/api\/(?:ai|usage)$/, aiFn({ ai: fakeAI, stream: fakeStream, store: () => store, getUser }), () => ({})],
  [/^\/api\/templates(?:\/([^/]+))?$/, templatesFn({ store: () => store, getUser }), (m) => ({ id: m[1] })],
  [/^\/api\/(?:profile|account)$/, profileFn({ store: () => store, getUser, deleteIdentityUser: async () => {} }), () => ({})],
];
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png" };

export function start(port = 8777) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    if (url.pathname.startsWith("/.netlify/identity")) return identity(req, res, url.pathname.replace("/.netlify/identity", ""), body);
    for (const [re, handler, params] of routes) {
      const m = url.pathname.match(re);
      if (!m) continue;
      currentNodeReq = req;
      const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
      const r = await handler(request, { params: params(m), ip: req.socket.remoteAddress });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body) return res.end();
      const reader = r.body.getReader(); // en vivo, como Netlify
      for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
      return res.end();
    }
    let file = normalize(join(ROOT, "public", url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(ROOT + "/public")) return res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}
export { mem };
if (process.argv[2] === "serve") start().then(() => console.log("Demo de Lacey Legal en http://localhost:8777 (IA simulada)"));
