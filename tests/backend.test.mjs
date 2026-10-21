// Pruebas del backend con un almacenamiento en memoria (no necesitan Netlify).
// Correr con: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandler as contracts } from "../netlify/functions/contracts.mjs";
import { makeHandler as share } from "../netlify/functions/share.mjs";
import { makeHandler as sign } from "../netlify/functions/sign.mjs";
import { makeHandler as ai } from "../netlify/functions/ai.mjs";
import { runReminders, daysLeft } from "../netlify/functions/reminders.mjs";

function memStore() {
  const m = new Map();
  return {
    m,
    async get(k, o) { if (!m.has(k)) return null; const v = m.get(k); return o?.type === "json" ? JSON.parse(v) : v; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}

const ORIGIN = "https://lacey.test";
const req = (method, path, body, origin = ORIGIN) =>
  new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const call = async (h, method, path, body, params = {}, origin) => {
  const res = await h(req(method, path, body, origin), { params });
  return { status: res.status, data: await res.json() };
};

const store = memStore();
const ana = { id: "user-ana", email: "ana@test.com", name: "Ana" };
const bea = { id: "user-bea", email: "bea@test.com" };
const C = (user) => contracts({ store: () => store, getUser: async () => user });
const CID = "11111111-2222-3333-4444-555555555555";
const SIG = "data:image/png;base64,iVBORw0KGgo=";

test("sin sesión → 401", async () => {
  const r = await call(contracts({ store: () => store, getUser: async () => null }), "GET", "/api/contracts");
  assert.equal(r.status, 401);
});

test("crear, listar, leer, versiones y conflicto", async () => {
  let r = await call(C(ana), "PUT", `/api/contracts/${CID}`, { title: "NDA", html: "<h1>NDA</h1>", endDate: "2026-10-25", remindEmail: true }, { id: CID });
  assert.equal(r.status, 200);
  const base = r.data.updated;

  r = await call(C(ana), "GET", "/api/contracts");
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0].title, "NDA");

  r = await call(C(ana), "PUT", `/api/contracts/${CID}`, { title: "NDA", html: "<h1>NDA v2</h1>", base, version: "Edición IA" }, { id: CID });
  assert.equal(r.status, 200);

  // Guardar con la base vieja → conflicto con la versión más nueva
  r = await call(C(ana), "PUT", `/api/contracts/${CID}`, { title: "NDA", html: "<h1>viejo</h1>", base }, { id: CID });
  assert.equal(r.status, 409);
  assert.equal(r.data.latest.html, "<h1>NDA v2</h1>");

  r = await call(C(ana), "GET", `/api/contracts/${CID}/versions`, null, { id: CID });
  assert.deepEqual(r.data.map((v) => v.label), ["Edición IA", "Creado"]);
  r = await call(C(ana), "GET", `/api/contracts/${CID}/versions/${r.data[1].id}`, null, { id: CID, vid: r.data[1].id });
  assert.equal(r.data.html, "<h1>NDA</h1>");
});

test("otra usuaria no ve mis contratos", async () => {
  const r = await call(C(bea), "GET", `/api/contracts/${CID}`, null, { id: CID });
  assert.equal(r.status, 404);
  assert.equal((await call(C(bea), "GET", "/api/contracts")).data.items.length, 0);
});

test("bloquea peticiones de otro sitio", async () => {
  const r = await call(C(ana), "PUT", `/api/contracts/${CID}`, { html: "<p>x</p>" }, { id: CID }, "https://malo.com");
  assert.equal(r.status, 403);
});

test("firma por link de punta a punta", async () => {
  const S = share({ store: () => store, getUser: async () => ana });
  let r = await call(S, "POST", "/api/share", { cid: CID, signers: [{ name: "Bea", role: "Cliente" }] });
  assert.equal(r.status, 200);
  const token = r.data.links[0].token;
  assert.match(token, /^[a-f0-9]{48}$/);

  const G = sign({ store: () => store });
  r = await call(G, "GET", `/api/sign/${token}`, null, { token });
  assert.equal(r.data.status, "pending");
  assert.equal(r.data.signerName, "Bea");

  r = await call(G, "POST", `/api/sign/${token}`, { name: "Bea <b>", signature: "data:image/svg+xml,<svg>", agree: true }, { token });
  assert.equal(r.status, 400, "rechaza firmas que no son PNG");

  r = await call(G, "POST", `/api/sign/${token}`, { name: "Bea <b>", signature: SIG, agree: true }, { token });
  assert.equal(r.status, 200);

  r = await call(G, "POST", `/api/sign/${token}`, { name: "Bea", signature: SIG, agree: true }, { token });
  assert.equal(r.status, 409, "no se puede firmar dos veces");

  r = await call(C(ana), "GET", `/api/contracts/${CID}`, null, { id: CID });
  assert.ok(r.data.html.includes('class="sig-block"'));
  assert.ok(r.data.html.includes("Bea &lt;b&gt;"), "el nombre se escapa");
  const list = (await call(C(ana), "GET", "/api/contracts")).data.items;
  assert.equal(list[0].shares[0].status, "signed");
  const versions = (await call(C(ana), "GET", `/api/contracts/${CID}/versions`, null, { id: CID })).data;
  assert.equal(versions[0].label, "Firmado por Bea <b>");
});

test("link vencido", async () => {
  const S = share({ store: () => store, getUser: async () => ana });
  const { data } = await call(S, "POST", "/api/share", { cid: CID, signers: [{ name: "Caro" }] });
  const tk = data.links[0].token;
  const G = sign({ store: () => store, now: () => Date.now() + 31 * 864e5 });
  const r = await call(G, "POST", `/api/sign/${tk}`, { name: "Caro", signature: SIG, agree: true }, { token: tk });
  assert.equal(r.status, 410);
});

test("recordatorios por correo", async () => {
  process.env.RESEND_API_KEY = "test";
  const sentTo = [];
  const fetchImpl = async (url, o) => { sentTo.push(JSON.parse(o.body).to[0]); return { ok: true, text: async () => "" }; };
  const now = Date.parse("2026-10-20T12:00:00Z"); // vence el 25 → faltan 5 días (< 7)
  assert.equal(daysLeft("2026-10-25", now), 5);
  assert.equal(await runReminders({ store, now, fetchImpl }), 1);
  assert.deepEqual(sentTo, ["ana@test.com"]);
  assert.equal(await runReminders({ store, now, fetchImpl }), 0, "no repite el aviso");
});

test("borrar contrato elimina versiones y links", async () => {
  await call(C(ana), "DELETE", `/api/contracts/${CID}`, null, { id: CID });
  assert.equal([...store.m.keys()].filter((k) => k.startsWith("shares/") || k.includes(CID)).length, 0);
});

test("IA: valida acciones y cachea traducciones de la interfaz", async () => {
  let calls = 0;
  const fake = async ({ json }) => { calls++; return json ? ["Hello", "World"] : "<h1>Hi</h1>"; };
  const H = ai({ ai: fake, store: () => store, getUser: async () => null });
  assert.equal((await call(H, "POST", "/api/ai", { action: "nope" })).status, 400);
  assert.equal((await call(H, "POST", "/api/ai", { action: "analyze", file: { mime: "application/zip", data: "AAAA" } })).status, 400);
  let r = await call(H, "POST", "/api/ai", { action: "translateUI", language: "English", strings: ["Hola", "Mundo"] });
  assert.deepEqual(r.data.result, ["Hello", "World"]);
  r = await call(H, "POST", "/api/ai", { action: "translateUI", language: "English", strings: ["Hola", "Mundo"] });
  assert.equal(r.data.cached, true);
  assert.equal(calls, 1);
});

test("chat de Lacey: valida, pasa el contrato y filtra la respuesta", async () => {
  let seen;
  const fake = async (o) => { seen = o; return { reply: "Hola, soy Lacey.", mood: "rara", actions: ["review", "borrar-todo", "share", "pdf"] }; };
  const H = ai({ ai: fake, store: () => store, getUser: async () => ana });
  assert.equal((await call(H, "POST", "/api/ai", { action: "chat", messages: [] })).status, 400);
  assert.equal((await call(H, "POST", "/api/ai", { action: "chat", messages: [{ role: "lacey", text: "hola" }] })).status, 400);
  const r = await call(H, "POST", "/api/ai", {
    action: "chat", language: "Spanish", contract: "CLÁUSULA PRIMERA: pago de 500",
    page: { loggedIn: true, title: "Alquiler" },
    messages: [{ role: "user", text: "¿Cuánto pago?" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.mood, "normal", "expresión desconocida → normal");
  assert.deepEqual(r.data.result.actions, ["review", "share"], "solo acciones conocidas, máx. 2");
  assert.ok(seen.parts[0].text.includes("CLÁUSULA PRIMERA"), "manda el contrato");
  assert.ok(seen.parts[0].text.includes("Sesión iniciada: sí"));
  assert.ok(/emojis/.test(seen.system), "pide no usar emojis");
});


// ───────────────────────── funciones nuevas ─────────────────────────
import { makeHandler as templates, templateFields } from "../netlify/functions/templates.mjs";
import { makeHandler as profile } from "../netlify/functions/profile.mjs";
import { contractText, documentHash } from "../shared/integrity.mjs";

const CID2 = "22222222-2222-3333-4444-555555555555";
const S2 = () => share({ store: () => store, getUser: async () => ana, fetchImpl: async () => ({ ok: true, text: async () => "" }) });
const G2 = (opts = {}) => sign({ store: () => store, fetchImpl: async () => ({ ok: true, text: async () => "" }), ...opts });

test("huella del documento ignora las firmas y el formato", async () => {
  const a = "<h1>Contrato</h1><p>Pago de <strong>500</strong> &amp; más</p>";
  const b = a + '<h2>Firmas</h2><div class="signatures"><div class="sig-block"><img src="x"><p class="sig-line">Ana</p><p class="sig-meta">x</p></div></div>';
  assert.equal(contractText(a), "Contrato Pago de 500 & más");
  assert.equal(await documentHash(a), await documentHash(b));
  assert.notEqual(await documentHash(a), await documentHash(a.replace("500", "600")));
});

test("varios firmantes en orden, comentarios, auditoría y carpetas", async () => {
  let r = await call(C(ana), "PUT", `/api/contracts/${CID2}`, { title: "Alquiler", html: "<h1>Alquiler</h1><p>Pago 500</p>" }, { id: CID2 });
  assert.equal(r.status, 200);

  // Carpeta: no cuenta como edición (no cambia "updated")
  const before = (await call(C(ana), "GET", `/api/contracts/${CID2}`, null, { id: CID2 })).data.updated;
  r = await call(C(ana), "PATCH", `/api/contracts/${CID2}`, { folder: "Clientes" }, { id: CID2 });
  assert.equal(r.data.folder, "Clientes");
  r = await call(C(ana), "GET", "/api/contracts");
  const meta = r.data.items.find((x) => x.id === CID2);
  assert.equal(meta.folder, "Clientes");
  assert.equal((await call(C(ana), "GET", `/api/contracts/${CID2}`, null, { id: CID2 })).data.updated, before);

  r = await call(S2(), "POST", "/api/share", {
    cid: CID2, ordered: true,
    signers: [{ name: "Bea", email: "bea@x.com" }, { name: "Caro", email: "caro@x.com" }],
  });
  assert.equal(r.status, 200);
  const [t1, t2] = r.data.links.map((l) => l.token);

  // Caro no puede firmar antes que Bea
  r = await call(G2(), "GET", `/api/sign/${t2}`, null, { token: t2 });
  assert.equal(r.data.status, "waiting");
  assert.deepEqual(r.data.waitingFor, ["Bea"]);
  r = await call(G2(), "POST", `/api/sign/${t2}`, { name: "Caro", signature: SIG, agree: true }, { token: t2 });
  assert.equal(r.status, 409);

  // Bea pide un cambio
  r = await call(G2(), "POST", `/api/sign/${t1}/comment`, { text: "Bajemos el pago a 450", quote: "Pago 500" }, { token: t1 });
  assert.equal(r.status, 200);
  let list = (await call(C(ana), "GET", "/api/contracts")).data.items;
  assert.equal(list.find((x) => x.id === CID2).openComments, 1);
  let c = (await call(C(ana), "GET", `/api/contracts/${CID2}`, null, { id: CID2 })).data;
  const commentId = c.comments[0].id;
  assert.equal(c.comments[0].quote, "Pago 500");

  // La dueña responde y resuelve; Bea ve la respuesta
  r = await call(C(ana), "PATCH", `/api/contracts/${CID2}/comments/${commentId}`, { reply: "Listo, lo cambié", status: "resolved" }, { id: CID2, commentId });
  assert.equal(r.data.openComments, 0);
  r = await call(G2(), "GET", `/api/sign/${t1}`, null, { token: t1 });
  assert.equal(r.data.comments[0].reply, "Listo, lo cambié");
  assert.equal(r.data.comments[0].status, "resolved");

  // Firman en orden
  r = await call(G2(), "POST", `/api/sign/${t1}`, { name: "Bea", signature: SIG, agree: true }, { token: t1 });
  assert.equal(r.status, 200);
  assert.match(r.data.hash, /^[a-f0-9]{64}$/);
  r = await call(G2(), "POST", `/api/sign/${t2}`, { name: "Caro", signature: SIG, agree: true }, { token: t2 });
  assert.equal(r.status, 200);

  c = (await call(C(ana), "GET", `/api/contracts/${CID2}`, null, { id: CID2 })).data;
  const types = c.audit.map((e) => e.type);
  for (const t of ["created", "sent", "viewed", "comment", "signed"]) assert.ok(types.includes(t), `audit ${t}`);
  const signed = c.audit.filter((e) => e.type === "signed");
  assert.equal(signed.length, 2);
  assert.equal(signed[1].hash, await documentHash(c.html), "la huella coincide con el documento final");
  list = (await call(C(ana), "GET", "/api/contracts")).data.items;
  assert.equal(list.find((x) => x.id === CID2).sigCount, 2);

  // Al guardar, la firma hecha aquí queda en la auditoría
  r = await call(C(ana), "PUT", `/api/contracts/${CID2}`, { title: "Alquiler", html: c.html, base: c.updated, auditEvent: { type: "signed-here", name: "Ana" } }, { id: CID2 });
  assert.equal(r.status, 200);
  c = (await call(C(ana), "GET", `/api/contracts/${CID2}`, null, { id: CID2 })).data;
  assert.equal(c.audit.at(-1).type, "signed-here");
  assert.equal(c.folder, "Clientes", "guardar no pierde la carpeta");
});

test("recordatorios a quienes no firmaron", async () => {
  const CID3 = "33333333-2222-3333-4444-555555555555";
  await call(C(ana), "PUT", `/api/contracts/${CID3}`, { title: "NDA", html: "<h1>NDA</h1>" }, { id: CID3 });
  await call(S2(), "POST", "/api/share", { cid: CID3, signers: [{ name: "Dani", email: "dani@x.com" }] });
  process.env.RESEND_API_KEY = "test";
  const to = [];
  const fetchImpl = async (u, o) => { to.push(JSON.parse(o.body).to[0]); return { ok: true, text: async () => "" }; };
  assert.equal(await runReminders({ store, now: Date.now() + 864e5, fetchImpl, siteUrl: "https://x" }), 0, "antes de 3 días no recuerda");
  await runReminders({ store, now: Date.now() + 3.5 * 864e5, fetchImpl, siteUrl: "https://x" });
  assert.ok(to.includes("dani@x.com"));
  const n = to.length;
  await runReminders({ store, now: Date.now() + 4 * 864e5, fetchImpl, siteUrl: "https://x" });
  assert.equal(to.filter((x) => x === "dani@x.com").length, to.slice(0, n).filter((x) => x === "dani@x.com").length, "no repite el mismo día");
});

test("plantillas: detecta campos y es privada", async () => {
  assert.deepEqual(templateFields("<p>Entre {nombre} y {cliente}, por {monto}. {nombre}</p>"), ["nombre", "cliente", "monto"]);
  const T = (u) => templates({ store: () => store, getUser: async () => u });
  const TID = "44444444-2222-3333-4444-555555555555";
  let r = await call(T(ana), "PUT", `/api/templates/${TID}`, { name: "Servicios", html: "<h1>Servicios</h1><p>{cliente} paga {monto}</p>" }, { id: TID });
  assert.deepEqual(r.data.fields, ["cliente", "monto"]);
  assert.equal((await call(T(ana), "GET", "/api/templates")).data.length, 1);
  assert.equal((await call(T(bea), "GET", "/api/templates")).data.length, 0);
  assert.equal((await call(T(ana), "GET", `/api/templates/${TID}`, null, { id: TID })).data.name, "Servicios");
  await call(T(ana), "DELETE", `/api/templates/${TID}`, null, { id: TID });
  assert.equal((await call(T(ana), "GET", "/api/templates")).data.length, 0);
});

test("perfil: valida el logo y borrar cuenta elimina todo", async () => {
  const P = (u, extra = {}) => profile({ store: () => store, getUser: async () => u, ...extra });
  let r = await call(P(bea), "PUT", "/api/profile", { name: "Bea Studio", logo: "data:image/svg+xml;base64,AAA" });
  assert.equal(r.status, 400, "rechaza SVG");
  r = await call(P(bea), "PUT", "/api/profile", { name: "Bea Studio", logo: "data:image/png;base64,iVBORw0KGgo=", useAsPartyA: true });
  assert.equal(r.data.name, "Bea Studio");
  assert.equal((await call(P(bea), "GET", "/api/profile")).data.useAsPartyA, true);

  await call(C(bea), "PUT", `/api/contracts/${CID}`, { title: "X", html: "<h1>X</h1>" }, { id: CID });
  let deleted = null;
  r = await call(P(bea, { deleteIdentityUser: async (id) => { deleted = id; } }), "DELETE", "/api/account");
  assert.equal(r.data.accountDeleted, true);
  assert.equal(deleted, "user-bea");
  assert.equal([...store.m.keys()].filter((k) => k.startsWith("users/user-bea/")).length, 0);
  assert.ok([...store.m.keys()].some((k) => k.startsWith("users/user-ana/")), "no toca a otras usuarias");
});

test("límite diario de IA", async () => {
  process.env.AI_DAILY_LIMIT_ANON = "2";
  const fake = async () => "<h1>Hola</h1>";
  const H = ai({ ai: fake, store: () => store, getUser: async () => null });
  const body = { action: "generate", details: "Un contrato de prueba largo" };
  const R = (ip) => H(new Request(ORIGIN + "/api/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "x-nf-client-connection-ip": ip }, body: JSON.stringify(body) }), { params: {} });
  assert.equal((await R("1.1.1.1")).status, 200);
  assert.equal((await R("1.1.1.1")).status, 200);
  const third = await R("1.1.1.1");
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /Iniciá sesión/);
  assert.equal((await R("2.2.2.2")).status, 200, "otra IP tiene su propio límite");
  const u = await H(new Request(ORIGIN + "/api/usage", { headers: { "x-nf-client-connection-ip": "1.1.1.1" } }), { params: {} });
  assert.deepEqual(await u.json(), { used: 2, limit: 2, loggedIn: false });
  delete process.env.AI_DAILY_LIMIT_ANON;
});
