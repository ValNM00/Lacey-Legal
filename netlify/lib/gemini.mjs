// Cliente de la API de Google Gemini, con respaldo de modelos y reintentos.
//
// Google retira modelos cada pocos meses (por ejemplo, gemini-2.5-flash dejó de
// estar disponible para claves nuevas en septiembre de 2026). Por eso probamos
// una lista: si un modelo ya no existe, pasamos al siguiente y recordamos el que
// funcionó. Con GEMINI_MODEL se puede forzar uno.
import { HttpError, env } from "./http.mjs";

export const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.6-flash"];

let workingModel = null; // el último modelo que respondió bien (dura mientras la función siga "caliente")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** El modelo no existe o ya no está disponible para esta clave → probar otro. */
const isGone = (status, msg) =>
  status === 404 || /no longer available|not found|is not supported|deprecated|retired|unknown model/i.test(msg || "");

/** El error es por la configuración de "thinking" → reintentar sin ella. */
const isThinkingError = (status, msg) => status === 400 && /think/i.test(msg || "");

function thinkingFor(model, think) {
  if (/2\.5-flash/.test(model)) return think ? undefined : { thinkingBudget: 0 };
  if (/gemini-[3-9]/.test(model) || /latest/.test(model)) return { thinkingLevel: think ? "medium" : "low" };
  return undefined;
}

/**
 * @param {object} o
 * @param {string} o.system      instrucciones de sistema
 * @param {Array}  o.parts       partes del mensaje del usuario ({text} o {inlineData})
 * @param {number} [o.temperature]
 * @param {object|true} [o.json] true = respuesta JSON libre; objeto = responseSchema
 * @param {boolean} [o.think]    pensar más (más lento, mejor para revisar y analizar)
 */
export async function gemini({ system, parts, temperature = 0.5, json, think = false, fetchImpl = fetch, wait = sleep }) {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new HttpError(500, "Falta configurar GEMINI_API_KEY en Netlify (Project configuration → Environment variables).");

  const forced = env("GEMINI_MODEL");
  const candidates = [...new Set([forced, workingModel, ...DEFAULT_MODELS].filter(Boolean))];
  let lastError = "";

  for (const model of candidates) {
    let thinking = thinkingFor(model, think);
    for (let attempt = 0; attempt < 3; attempt++) {
      const generationConfig = { temperature, maxOutputTokens: 16384 };
      if (thinking) generationConfig.thinkingConfig = thinking;
      if (json) {
        generationConfig.responseMimeType = "application/json";
        if (typeof json === "object") generationConfig.responseSchema = json;
      }

      let res;
      let data = {};
      try {
        res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts }],
            generationConfig,
          }),
        });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        lastError = err.message;
        await wait(800);
        continue;
      }

      if (res.ok) {
        workingModel = model;
        return parseResult(data, json);
      }

      const msg = data?.error?.message || `código ${res.status}`;
      console.error(`Gemini ${model} → ${res.status}: ${msg}`);
      lastError = msg;

      if (isThinkingError(res.status, msg) && thinking) { thinking = undefined; continue; }
      if (isGone(res.status, msg)) break; // probar el siguiente modelo
      if (res.status === 429 || res.status === 503 || res.status === 500) {
        if (attempt < 2) { await wait(1500 * (attempt + 1)); continue; }
        throw new HttpError(429, "La IA está con mucha demanda en este momento. Probá de nuevo en un minuto.");
      }
      if (res.status === 400 && /api key/i.test(msg)) {
        throw new HttpError(500, "La clave de Gemini (GEMINI_API_KEY) no es válida. Revisala en Netlify.");
      }
      if (res.status === 403) {
        throw new HttpError(500, "La clave de Gemini no tiene permiso para usar la IA. Revisá GEMINI_API_KEY en Netlify.");
      }
      throw new HttpError(502, `La IA no pudo responder (${msg}).`);
    }
  }
  throw new HttpError(502, `Ningún modelo de IA está disponible ahora (${lastError}). Revisá GEMINI_MODEL en Netlify.`);
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

export const lastModel = () => workingModel;

/** Solo para pruebas. */
export const _resetWorkingModel = () => { workingModel = null; };
