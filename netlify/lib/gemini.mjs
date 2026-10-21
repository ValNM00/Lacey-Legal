// Cliente mínimo de la API de Google Gemini.
import { HttpError, env } from "./http.mjs";

/**
 * @param {object} o
 * @param {string} o.system      instrucciones de sistema
 * @param {Array}  o.parts       partes del mensaje del usuario ({text} o {inlineData})
 * @param {number} [o.temperature]
 * @param {object|true} [o.json] true = respuesta JSON libre; objeto = responseSchema
 * @param {boolean} [o.think]    permitir "thinking" (más lento, mejor para análisis)
 */
export async function gemini({ system, parts, temperature = 0.5, json, think = false, fetchImpl = fetch }) {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new HttpError(500, "Falta configurar GEMINI_API_KEY en Netlify (Project configuration → Environment variables).");
  const model = env("GEMINI_MODEL") || "gemini-2.5-flash";

  const generationConfig = { temperature, maxOutputTokens: 8192 };
  if (/2\.5-flash/.test(model) && !think) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (json) {
    generationConfig.responseMimeType = "application/json";
    if (typeof json === "object") generationConfig.responseSchema = json;
  }

  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig,
    }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 429) throw new HttpError(429, "La IA está saturada o llegaste al límite gratis. Probá de nuevo en un minuto");
    const msg = data?.error?.message || `código ${res.status}`;
    console.error("Gemini error:", res.status, msg);
    throw new HttpError(502, `La IA no pudo responder (${msg}).`);
  }

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
