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
  const fake = async ({ json }) => { calls++; return json ? [{ i: 0, t: "Hello" }, { i: 1, t: "World" }] : "<h1>Hi</h1>"; };
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
  assert.match((await third.json()).error, /Creá una cuenta/);
  assert.equal((await R("2.2.2.2")).status, 200, "otra IP tiene su propio límite");
  const u = await H(new Request(ORIGIN + "/api/usage", { headers: { "x-nf-client-connection-ip": "1.1.1.1" } }), { params: {} });
  const uj = await u.json();
  assert.deepEqual([uj.used, uj.limit, uj.loggedIn], [2, 2, false]);
  assert.match(uj.version, /v6/);
  delete process.env.AI_DAILY_LIMIT_ANON;
});


// ───────────────────────── modelos de Gemini ─────────────────────────
import { gemini, _resetWorkingModel } from "../netlify/lib/gemini.mjs";

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const okText = (text) => reply(200, { candidates: [{ content: { parts: [{ text }] } }] });

test("Gemini: si un modelo fue retirado, usa el siguiente y lo recuerda", async () => {
  process.env.GEMINI_API_KEY = "k";
  delete process.env.GEMINI_MODEL;
  _resetWorkingModel();
  const seen = [];
  const fetchImpl = async (url, o) => {
    const model = url.match(/models\/([^:]+):/)[1];
    seen.push({ model, cfg: JSON.parse(o.body).generationConfig });
    if (model === "gemini-3.8-flash") return reply(404, { error: { message: "This model models/gemini-3.8-flash is no longer available." } });
    return okText("hola");
  };
  assert.equal(await gemini({ system: "s", parts: [{ text: "x" }], fetchImpl, wait: async () => {} }), "hola");
  assert.deepEqual(seen.map((x) => x.model), ["gemini-3.8-flash", "gemini-3.6-flash"]);
  assert.equal(seen[1].cfg.thinkingConfig.thinkingLevel, "minimal");
  seen.length = 0;
  await gemini({ system: "s", parts: [{ text: "x" }], fetchImpl, wait: async () => {} });
  assert.equal(seen[0].model, "gemini-3.6-flash", "no vuelve a probar el modelo retirado");
});

test("Gemini: reintenta si está saturado y sin 'thinking' si el modelo no lo acepta", async () => {
  _resetWorkingModel();
  let n = 0;
  let r = await gemini({ system: "s", parts: [{ text: "x" }], wait: async () => {}, fetchImpl: async () => (++n < 3 ? reply(429, { error: { message: "quota" } }) : okText("ok")) });
  assert.equal(r, "ok");
  assert.equal(n, 3);
  _resetWorkingModel();
  const cfgs = [];
  r = await gemini({ system: "s", parts: [{ text: "x" }], wait: async () => {}, fetchImpl: async (u, o) => {
    const cfg = JSON.parse(o.body).generationConfig; cfgs.push(cfg);
    return cfg.thinkingConfig ? reply(400, { error: { message: "thinking_level is not supported for this model" } }) : okText("sin pensar");
  } });
  assert.equal(r, "sin pensar");
  assert.ok(cfgs[0].thinkingConfig && !cfgs[1].thinkingConfig);
});

test("Gemini: clave inválida da un mensaje claro", async () => {
  _resetWorkingModel();
  await assert.rejects(
    gemini({ system: "s", parts: [{ text: "x" }], wait: async () => {}, fetchImpl: async () => reply(400, { error: { message: "API key not valid. Please pass a valid API key." } }) }),
    /GEMINI_API_KEY/,
  );
});

test("Traducir la página: alinea por índice y no gasta el límite diario", async () => {
  process.env.AI_DAILY_LIMIT_ANON = "1";
  const fake = async ({ json }) => [{ i: 1, t: "Mundo" }, { i: 0, t: "Hola" }, { i: 2, t: "Hecho" }];
  const H = ai({ ai: fake, store: () => memStore(), getUser: async () => null });
  const R = (body) => H(new Request(ORIGIN + "/api/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "x-nf-client-connection-ip": "9.9.9.9" }, body: JSON.stringify(body) }), { params: {} });
  for (let k = 0; k < 3; k++) {
    const r = await R({ action: "translateUI", language: "Spanish" + k, strings: ["Hello", "World", "Done"] });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).result, ["Hola", "Mundo", "Hecho"]);
  }
  delete process.env.AI_DAILY_LIMIT_ANON;
});

test("los errores de la IA no gastan el límite diario", async () => {
  process.env.AI_DAILY_LIMIT_ANON = "2";
  let fail = true;
  const flaky = async () => { if (fail) throw new Error("Google caído"); return "<h1>Ok</h1>"; };
  const H = ai({ ai: flaky, store: () => store, getUser: async () => null });
  const R = () => H(new Request(ORIGIN + "/api/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "x-nf-client-connection-ip": "7.7.7.7" }, body: JSON.stringify({ action: "generate", details: "Un contrato de prueba largo" }) }), { params: {} });
  for (let i = 0; i < 5; i++) assert.equal((await R()).status, 500);
  fail = false;
  assert.equal((await R()).status, 200, "después de 5 errores todavía tiene sus 2 usos");
  assert.equal((await R()).status, 200);
  assert.equal((await R()).status, 429);
  delete process.env.AI_DAILY_LIMIT_ANON;
});

import { resolveUser } from "../netlify/lib/auth.mjs";
test("sesión: si la librería no la lee, la confirma con Netlify Identity", async () => {
  const r = new Request(ORIGIN + "/api/ai", { headers: { cookie: "otra=1; nf_jwt=token-valido" } });
  let asked = null;
  const fetchImpl = async (url, o) => { asked = [url, o.headers.Authorization]; return { ok: true, json: async () => ({ id: "u-1", email: "v@x.com" }) }; };
  const u = await resolveUser(r, async () => null, fetchImpl);
  assert.equal(u.id, "u-1");
  assert.deepEqual(asked, [ORIGIN + "/.netlify/identity/user", "Bearer token-valido"]);
  const bad = await resolveUser(r, async () => null, async () => ({ ok: false }));
  assert.equal(bad, null, "token inválido → sin sesión");
});

test("Gemini: el error exacto de Google ('no longer available to new users') pasa al modelo nuevo", async () => {
  process.env.GEMINI_API_KEY = "k";
  process.env.GEMINI_MODEL = "gemini-2.5-flash"; // aunque alguien la haya dejado configurada
  _resetWorkingModel();
  const used = [];
  const msg = "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.";
  for (const status of [400, 403, 404]) {
    used.length = 0;
    _resetWorkingModel();
    const r = await gemini({ system: "s", parts: [{ text: "x" }], wait: async () => {}, fetchImpl: async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      used.push(model);
      return model === "gemini-2.5-flash" ? reply(status, { error: { message: msg } }) : okText("listo");
    } });
    assert.equal(r, "listo", `status ${status}`);
    assert.deepEqual(used, ["gemini-2.5-flash", "gemini-3.8-flash"]);
  }
  delete process.env.GEMINI_MODEL;
});

test("Gemini: si un modelo está saturado (429) pasa al siguiente sin esperar, y lo evita un rato", async () => {
  process.env.GEMINI_API_KEY = "k";
  _resetWorkingModel();
  const seen = [];
  let waits = 0;
  const fetchImpl = async (url) => {
    const model = url.match(/models\/([^:]+):/)[1];
    seen.push(model);
    return model === "gemini-3.5-flash-lite" ? reply(429, { error: { message: "Resource exhausted" } }) : okText("ok");
  };
  assert.equal(await gemini({ tier: "fast", system: "s", parts: [{ text: "x" }], fetchImpl, wait: async () => { waits++; } }), "ok");
  assert.deepEqual(seen, ["gemini-3.5-flash-lite", "gemini-3.6-flash"]);
  assert.equal(waits, 0);
  seen.length = 0;
  await gemini({ tier: "fast", system: "s", parts: [{ text: "x" }], fetchImpl, wait: async () => {} });
  assert.deepEqual(seen, ["gemini-3.6-flash"], "el saturado queda al final por unos segundos");
});

test("Gemini: si todos están saturados avisa con 429 claro", async () => {
  process.env.GEMINI_API_KEY = "k";
  _resetWorkingModel();
  await assert.rejects(
    gemini({ tier: "fast", system: "s", parts: [{ text: "x" }], wait: async () => {}, fetchImpl: async () => reply(429, { error: { message: "quota" } }) }),
    (e) => e.status === 429 && /mucha demanda/.test(e.message),
  );
});

import { geminiStream } from "../netlify/lib/gemini.mjs";
test("Gemini en vivo: junta el texto de los eventos y salta el 'pensamiento'", async () => {
  process.env.GEMINI_API_KEY = "k";
  _resetWorkingModel();
  const ev = (parts) => `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`;
  const sse = ev([{ text: "pienso", thought: true }]) + ev([{ text: "<h1>Hola" }]) + ev([{ text: "</h1>" }]);
  let url = "";
  const fetchImpl = async (u) => { url = u; return { ok: true, status: 200, body: new Response(sse).body }; };
  let out = "";
  for await (const t of await geminiStream({ system: "s", parts: [{ text: "x" }], fetchImpl })) out += t;
  assert.equal(out, "<h1>Hola</h1>");
  assert.match(url, /streamGenerateContent\?alt=sse/);
});

test("IA en vivo: generar con stream devuelve texto en pedazos y cuenta un uso", async () => {
  const fakeStream = async () => (async function* () { yield "<h1>Con"; yield "trato</h1>"; })();
  const H = ai({ ai: async () => "x", stream: fakeStream, store: () => store, getUser: async () => null });
  const res = await H(new Request(ORIGIN + "/api/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "x-nf-client-connection-ip": "9.9.9.9" }, body: JSON.stringify({ action: "generate", details: "Un contrato de prueba", stream: true }) }), { params: {} });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/plain/);
  assert.equal(await res.text(), "<h1>Contrato</h1>");
  const u = await (await H(new Request(ORIGIN + "/api/usage", { headers: { "x-nf-client-connection-ip": "9.9.9.9" } }), { params: {} })).json();
  assert.equal(u.used, 1);
});

import { placeSignature, countSignatures } from "../shared/integrity.mjs";
const EMPTY = (n, r) => `<div class="sig-block"><p class="sig-line">${n}</p><p class="sig-meta">${r} · Fecha: [__________]</p></div>`;
const WITH_SLOTS = `<h1>C</h1><p>Texto</p><h2>Firmas</h2><div class="signatures">${EMPTY("Sofía Méndez", "Prestadora")}${EMPTY("Café Rosa S.A.", "Cliente")}</div>`;
const SIGNED = (n) => `<div class="sig-block"><img src="data:image/png;base64,AAAA" alt="x"><p class="sig-line">${n}</p><p class="sig-meta">firma</p></div>`;

test("firmas: ocupa el espacio de la persona por nombre o rol, y los espacios vacíos no cuentan", async () => {
  assert.equal(countSignatures(WITH_SLOTS), 0);
  let h = placeSignature(WITH_SLOTS, { block: SIGNED("Cafe Rosa SA"), name: "Cafe Rosa SA", role: "Cliente" });
  assert.equal(countSignatures(h), 1);
  assert.ok(h.indexOf("Sofía Méndez") < h.indexOf("<img"), "firmó en el espacio del cliente (el segundo)");
  assert.equal((h.match(/class="sig-block"/g) || []).length, 2, "no agrega un bloque extra");
  h = placeSignature(h, { block: SIGNED("Sofia Mendez"), name: "sofia mendez" });
  assert.equal(countSignatures(h), 2);
  h = placeSignature(h, { block: SIGNED("Tercera"), name: "Tercera persona" });
  assert.equal(countSignatures(h), 3, "sin espacios libres, se agrega dentro de la sección");
  assert.equal((h.match(/class="signatures"/g) || []).length, 1);
  assert.equal(await documentHash(h), await documentHash(WITH_SLOTS), "firmar no cambia la huella del texto");
  const old = placeSignature("<h1>Viejo</h1><p>sin firmas</p>", { block: SIGNED("Ana"), name: "Ana" });
  assert.match(old, /<h2>Firmas<\/h2><div class="signatures">/);
});

test("IA en vivo: si se acaba el tiempo avisa que falta (MORE) y 'continue' no gasta un uso", async () => {
  process.env.STREAM_BUDGET_MS = "1";
  const { makeHandler: aiFresh } = await import("../netlify/functions/ai.mjs?budget");
  const slow = async () => (async function* () { yield "<h1>A</h1>"; await new Promise((r) => setTimeout(r, 20)); yield "<p>B</p>"; yield "<p>C</p>"; })();
  const H = aiFresh({ ai: async () => "x", stream: slow, store: () => store, getUser: async () => null });
  const call = (b) => H(new Request(ORIGIN + "/api/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "x-nf-client-connection-ip": "7.7.7.71" }, body: JSON.stringify({ stream: true, ...b }) }), { params: {} });
  const text = await (await call({ action: "generate", details: "Contrato de prueba" })).text();
  assert.match(text, /\u0000MORE$/);
  assert.ok(!text.includes("<p>C</p>"), "cortó antes del final");
  const cont = await call({ action: "continue", mode: "generate", done: "<h1>A</h1><p>" + "x".repeat(60) + "</p>", details: "d" });
  assert.equal(cont.status, 200);
  await cont.text();
  const u = await (await H(new Request(ORIGIN + "/api/usage", { headers: { "x-nf-client-connection-ip": "7.7.7.71" } }), { params: {} })).json();
  assert.equal(u.used, 1, "la continuación no cuenta como otro uso");
  delete process.env.STREAM_BUDGET_MS;
});
