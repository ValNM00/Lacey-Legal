// Cliente de la API de Google Gemini: modelos por tipo de tarea, respaldo, reparto de carga y streaming.
//
// - "fast": modelo liviano (responde en 1–3 s) para traducir, editar, chatear.
// - "smart": modelo más capaz para redactar, revisar y analizar contratos.
// Cada modelo tiene su propio cupo de llamadas por minuto: si uno está saturado (429)
// pasamos al siguiente en vez de esperar. Si un modelo fue retirado (404) también.
// Con GEMINI_MODEL se puede forzar uno (va primero en las dos listas).
import { HttpError, env } from "./http.mjs";

export const MODEL_TIERS = {
  fast: ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-flash-lite-latest", "gemini-3.8-flash", "gemini-flash-latest"],
  smart: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-flash-latest", "gemini-3.5-flash-lite"],
};
export const DEFAULT_MODELS = MODEL_TIERS.smart;

const goneModels = new Set(); // retirados para esta clave (mientras la función siga "caliente")
const busyUntil = new Map(); // modelo → hora hasta la que lo evitamos por estar saturado
let lastUsed = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isGone = (status, msg) =>
  status === 404 || /no longer available|not found|is not supported for|deprecated|retired|unknown model|does not exist/i.test(msg || "");
const isThinkingError = (status, msg) => status === 400 && /think/i.test(msg || "");
const isBusy = (status) => status === 429 || status === 503 || status === 500 || status === 502;

function thinkingFor(model, think) {
  if (/2\.5-flash/.test(model)) return think ? undefined : { thinkingBudget: 0 };
  if (think) return { thinkingLevel: "medium" };
  // 3.8 no tiene "minimal"; los livianos y 3.6 sí.
  if (/3\.8|flash-latest$/.test(model)) return { thinkingLevel: "low" };
  if (/gemini-[3-9]|latest/.test(model)) return { thinkingLevel: "minimal" };
  return undefined;
}

function orderFor(tier) {
  const forced = env("GEMINI_MODEL");
  const list = [...new Set([forced, ...(MODEL_TIERS[tier] || MODEL_TIERS.smart)].filter(Boolean))].filter((m) => !goneModels.has(m));
  const now = Date.now();
  // Los saturados van al final (se usan solo si no queda otra).
  return [...list.filter((m) => (busyUntil.get(m) || 0) <= now), ...list.filter((m) => (busyUntil.get(m) || 0) > now)];
}

function requestBody({ system, parts, temperature, json, thinking }) {
  const generationConfig = { temperature, maxOutputTokens: 16384 };
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (json) {
    generationConfig.responseMimeType = "application/json";
    if (typeof json === "object") generationConfig.responseSchema = json;
  }
  return JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }], generationConfig });
}

/**
 * Prueba los modelos en orden hasta que uno responda bien.
 * send(model, thinking) → Response. Devuelve { res, model }.
 */
async function withFallback(tier, think, send, wait) {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new HttpError(500, "Falta configurar GEMINI_API_KEY en Netlify (Project configuration → Environment variables).");
  let lastError = "";
  let allBusy = true;

  for (let round = 0; round < 2; round++) {
    for (const model of orderFor(tier)) {
      let thinking = thinkingFor(model, think);
      for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
          res = await send(model, thinking, key);
        } catch (err) {
          lastError = err.message;
          break;
        }
        if (res.ok) {
          lastUsed = model;
          busyUntil.delete(model);
          return { res, model };
        }
        const data = await res.json().catch(() => ({}));
        const msg = data?.error?.message || `código ${res.status}`;
        console.error(`Gemini ${model} → ${res.status}: ${msg}`);
        lastError = msg;
        if (isThinkingError(res.status, msg) && thinking) { thinking = undefined; continue; }
        if (isGone(res.status, msg)) { goneModels.add(model); break; }
        if (isBusy(res.status)) { busyUntil.set(model, Date.now() + 20_000); break; } // probar otro modelo ya
        allBusy = false;
        if (res.status === 400 && /api key/i.test(msg)) throw new HttpError(500, "La clave de Gemini (GEMINI_API_KEY) no es válida. Revisala en Netlify.");
        if (res.status === 403) throw new HttpError(500, "La clave de Gemini no tiene permiso para usar la IA. Revisá GEMINI_API_KEY en Netlify.");
        throw new HttpError(502, `La IA no pudo responder (${msg}).`);
      }
    }
    if (round === 0) await wait(1200); // todos ocupados: una pausa corta y otra vuelta
  }
  if (allBusy) throw new HttpError(429, "La IA está con mucha demanda en este momento. Probá de nuevo en unos segundos.");
  throw new HttpError(502, `Ningún modelo de IA está disponible ahora (${lastError}).`);
}

/**
 * Respuesta completa.
 * @param {object} o
 * @param {"fast"|"smart"} [o.tier]
 * @param {boolean} [o.think] pensar más (revisar, analizar)
 */
export async function gemini({ system, parts, temperature = 0.5, json, think = false, tier = "smart", fetchImpl = fetch, wait = sleep }) {
  const { res } = await withFallback(tier, think, (model, thinking, key) =>
    fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: requestBody({ system, parts, temperature, json, thinking }),
    }), wait);
  return parseResult(await res.json().catch(() => ({})), json);
}

/**
 * Respuesta en vivo: devuelve un iterador asíncrono de pedazos de texto.
 * El primer pedido se hace antes de devolver, así los errores llegan como excepción normal.
 */
export async function geminiStream({ system, parts, temperature = 0.5, think = false, tier = "smart", fetchImpl = fetch, wait = sleep }) {
  const { res } = await withFallback(tier, think, (model, thinking, key) =>
    fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: requestBody({ system, parts, temperature, thinking }),
    }), wait);

  const meta = { finishReason: "" };
  const it = (async function* () {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let any = false;
    try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.candidates?.[0]?.finishReason) meta.finishReason = evt.candidates[0].finishReason;
        const text = (evt.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (text) { any = true; yield text; }
      }
    }
    } finally {
      reader.cancel().catch(() => {}); // si cortamos antes, no seguimos descargando
    }
    if (!any) throw new HttpError(502, "La IA no devolvió texto. Probá reformulando.");
  })();
  it.meta = meta; // finishReason: "MAX_TOKENS" si se quedó sin espacio
  return it;
}

function parseResult(data, json) {
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("")
    .trim();
  if (!text) {
    const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || "respuesta vacía";
    throw new HttpError(502, `La IA no devolvió texto (${reason}). Probá reformulando.`);
  }
  const clean = text.replace(/^```(?:html|json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!json) return clean;
  try {
    return JSON.parse(clean);
  } catch {
    throw new HttpError(502, "La IA devolvió una respuesta con formato inválido. Intentá de nuevo.");
  }
}

export const lastModel = () => lastUsed;

/** Solo para pruebas. */
export const _resetWorkingModel = () => { goneModels.clear(); busyUntil.clear(); lastUsed = null; };
