// /api/ai — todas las funciones de IA (Google Gemini).
//   generate   { contractType, details, language }         → HTML del contrato
//   rewrite    { mode, text }                              → texto
//   translate  { html, language }                          → HTML traducido
//   review     { text, language }                          → JSON de revisión
//   clause     { topic, why, language, title }             → HTML de una cláusula
//   analyze    { file: { mime, data } | text, language }   → JSON de análisis
//   translateUI{ strings, language }                       → [cadenas traducidas] (con caché)
//   chat       { messages, contract, page, language }      → { reply, mood, actions } (Lacey, la asistente)
//   templatize { html, language }                          → HTML con {campos} en lugar de los datos concretos
// GET /api/usage → { used, limit, loggedIn }   (límite diario de usos de IA)
import { getUser } from "@netlify/identity";
import { json, readJSON, str, wrap, checkOrigin, HttpError, env } from "../lib/http.mjs";
import { gemini, DEFAULT_MODELS, lastModel } from "../lib/gemini.mjs";

/** Versión publicada: abrí /api/usage en tu sitio para ver cuál está activa. */
export const APP_VERSION = "2026-10-20 · v4 (modelo nuevo de Gemini)";
import { openStore, getUsage, addUsage, clientIP } from "../lib/data.mjs";
import { sha256 } from "../../shared/integrity.mjs";
import { resolveUser } from "../lib/auth.mjs";

const limits = () => ({
  user: parseInt(env("AI_DAILY_LIMIT") || "100", 10) || 100,
  anon: parseInt(env("AI_DAILY_LIMIT_ANON") || "30", 10) || 30,
});

const HTML_RULES =
  "Devolvé SOLO HTML válido usando únicamente las etiquetas h1, h2, h3, p, ul, ol, li, strong, em, br. " +
  "Nada de markdown, nada de ```, nada de <html>, <head>, <body>, <style> ni atributos.";

const REWRITE_MODES = {
  improve: "Mejorá la redacción del texto para que sea más clara, precisa y profesional, sin cambiar su significado.",
  shorten: "Acortá el texto a aproximadamente la mitad, conservando las obligaciones y datos importantes.",
  lengthen: "Ampliá el texto agregando detalle y precisión jurídica útil, sin inventar datos concretos (usá [__________] si falta información).",
  grammar: "Corregí solo ortografía, gramática y puntuación. No cambies el estilo ni el contenido.",
  formal: "Reescribí el texto en un registro jurídico más formal.",
  simple: "Reescribí el texto en lenguaje sencillo que cualquier persona entienda, sin perder las obligaciones.",
};

const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"];
const MAX_FILE_B64 = 5_000_000; // ~3.7 MB de archivo

const S = (type, extra = {}) => ({ type, ...extra });
const REVIEW_SCHEMA = S("OBJECT", {
  properties: {
    score: S("INTEGER"),
    summary: S("STRING"),
    plain: S("STRING"),
    missing: S("ARRAY", { items: S("OBJECT", { properties: { title: S("STRING"), why: S("STRING") }, required: ["title", "why"] }) }),
    risks: S("ARRAY", {
      items: S("OBJECT", {
        properties: { level: S("STRING", { enum: ["alta", "media", "baja"] }), issue: S("STRING"), suggestion: S("STRING") },
        required: ["level", "issue", "suggestion"],
      }),
    }),
  },
  required: ["score", "summary", "plain", "missing", "risks"],
});

export const CHAT_ACTIONS = [
  "generate", "review", "share", "sign", "due", "versions", "translate", "pdf", "word", "analyze", "login", "tour",
  "dashboard", "templates", "comments", "certificate", "settings",
];
const CHAT_SCHEMA = S("OBJECT", {
  properties: {
    reply: S("STRING"),
    mood: S("STRING", { enum: ["normal", "feliz", "pensando", "preocupada"] }),
    actions: S("ARRAY", { items: S("STRING", { enum: CHAT_ACTIONS }) }),
  },
  required: ["reply", "mood", "actions"],
});

const LACEY_GUIDE = `Funciones de la app (para guiar a la usuaria; usá estos nombres de botones):
- Crear: en "Tu estudio de contratos" elige el tipo, describe el acuerdo (o usa el "Formulario guiado") y toca "Generar contrato".
- Editar: escribe directo sobre el contrato. Si selecciona un texto puede usar Mejorar, Acortar, Alargar, Corregir, Más formal o Más simple.
- "Revisar con IA": puntaje, explicación sencilla, cláusulas que faltan (se agregan con un clic) y riesgos.
- "Traducir": traduce todo el contrato a cualquier idioma.
- "Firmar aquí": dibujar una firma. "Enviar a firmar": hasta 8 personas, cada una con su link, opcionalmente en orden; con correo reciben invitación y recordatorios cada 3 días. Requiere iniciar sesión; los links vencen en 30 días. Ahí se ve el estado de cada firma (pendiente, lo abrió, espera su turno, firmó) y se puede "Recordar" o cancelar.
- Quien firma puede pedir cambios desde su link; aparecen en "Comentarios", donde se responde y se marca resuelto.
- "Certificado": quién firmó, cuándo, IP, dispositivo y la huella digital del documento; avisa si el texto cambió después de firmar. Se agrega solo al PDF.
- "Vencimiento": fecha de fin, aviso en la página, archivo de calendario y correo (con cuenta). "Versiones": ver, comparar en colores con la actual y restaurar.
- "Guardar como plantilla": convierte el contrato en plantilla con campos {así}; la IA puede detectar los datos. Se usan desde "Usar una plantilla".
- "Mis contratos" (panel arriba): estados (borradores, esperando firma, firmados, por vencer), búsqueda, carpetas, duplicar y pestaña de plantillas.
- "Ajustes" (engranaje): Mi marca (logo y datos en PDF y Word, y usar sus datos como una de las partes), tema de color, uso diario de IA y cuenta.
- Dictado por voz con el micrófono en la descripción y en este chat.
- Exportar: "PDF" y "Word". Sin cuenta se guarda en el navegador; con cuenta, en la nube.
- "Analizar": en la sección "¿Te mandaron un contrato?" se sube un PDF o foto y explica, marca banderas rojas y sugiere preguntas.
- Arriba: idioma de la página, tema de color (rosa, lila, durazno, oscuro) e "Iniciar sesión".`;

const ANALYZE_SCHEMA = S("OBJECT", {
  properties: {
    title: S("STRING"),
    kind: S("STRING"),
    parties: S("ARRAY", { items: S("STRING") }),
    summary: S("STRING"),
    keyPoints: S("ARRAY", { items: S("STRING") }),
    dates: S("ARRAY", { items: S("STRING") }),
    money: S("ARRAY", { items: S("STRING") }),
    redFlags: S("ARRAY", {
      items: S("OBJECT", {
        properties: { level: S("STRING", { enum: ["alta", "media", "baja"] }), issue: S("STRING"), why: S("STRING") },
        required: ["level", "issue", "why"],
      }),
    }),
    questions: S("ARRAY", { items: S("STRING") }),
    isContract: S("BOOLEAN"),
  },
  required: ["title", "kind", "parties", "summary", "keyPoints", "dates", "money", "redFlags", "questions", "isContract"],
});

export const makeHandler = ({ ai: model = gemini, store: storeFactory = openStore, getUser: getUserImpl = getUser, now = () => Date.now() } = {}) =>
  wrap(async (req, context) => {
    // Quién usa la IA: la cuenta si hay sesión; si no, la IP (cifrada).
    const user = await resolveUser(req, getUserImpl);
    const usageKey = user?.id ? `u_${user.id}` : `ip_${(await sha256((env("USAGE_SALT") || "lacey") + clientIP(req, context))).slice(0, 24)}`;
    const limit = user?.id ? limits().user : limits().anon;
    let usageStore = null;
    try { usageStore = storeFactory(); } catch { /* sin Blobs: sin límite */ }
    const readUsage = async () => {
      try { return usageStore ? await getUsage(usageStore, usageKey, now()) : 0; } catch { return 0; }
    };

    if (req.method === "GET") {
      return json({ used: Math.min(await readUsage(), limit), limit, loggedIn: !!user?.id, version: APP_VERSION, model: lastModel() || DEFAULT_MODELS[0] });
    }
    if (req.method !== "POST") throw new HttpError(405, "Método no permitido.");
    checkOrigin(req);
    const body = await readJSON(req, 5_500_000);

    // Solo cuenta un uso cuando la IA respondió bien: los errores no gastan el límite.
    const ai = async (opts) => {
      const used = await readUsage();
      if (used >= limit) {
        throw new HttpError(429, user?.id
          ? `Llegaste al límite de ${limit} usos de IA por hoy. Mañana se renueva.`
          : `Llegaste a los ${limit} usos gratis de hoy sin cuenta. Creá una cuenta gratis para seguir usando la IA.`, { limit: true });
      }
      const result = await model(opts);
      try { if (usageStore) await addUsage(usageStore, usageKey, now()); } catch { /* no bloquea */ }
      return result;
    };
    const language = str(body.language, 60) || "Spanish";

    switch (body.action) {
      case "generate": {
        const details = str(body.details, 5000);
        if (details.length < 8) throw new HttpError(400, "Faltan los detalles del contrato.");
        const result = await ai({
          system:
            "Sos una asistente experta en redactar borradores de contratos claros, completos y equilibrados para ambas partes. " +
            `Escribí todo el contrato en este idioma: ${language}. ` +
            "Estructura: un <h1> con el título; un párrafo de comparecencia que identifique a las partes; luego cláusulas numeradas, " +
            "cada una con su título en <h2> (por ejemplo 'Primera: Objeto') y su texto en <p> o listas. " +
            "Incluí según corresponda: objeto, obligaciones de cada parte, precio y forma de pago, plazo y vigencia, " +
            "terminación, confidencialidad, responsabilidad, ley aplicable y jurisdicción, y disposiciones finales. " +
            "Si se indica un país, adaptá la terminología y la ley aplicable a ese país. " +
            "Cuando falte un dato concreto (nombre, cédula, monto, dirección, fecha), dejá el espacio como [__________]. " +
            "Extensión: entre 600 y 1300 palabras. " +
            "No agregues la sección de firmas: la aplicación la agrega aparte. No agregues notas ni explicaciones fuera del contrato. " +
            HTML_RULES,
          parts: [{ text: `Tipo de contrato: ${str(body.contractType, 80) || "Personalizado"}\n\nDetalles:\n${details}` }],
          temperature: 0.6,
        });
        return json({ result });
      }

      case "rewrite": {
        const instruction = REWRITE_MODES[body.mode];
        const text = str(body.text, 8000);
        if (!instruction) throw new HttpError(400, "Modo de edición no válido.");
        if (!text) throw new HttpError(400, "No hay texto para editar.");
        const result = await ai({
          system:
            "Editás fragmentos de contratos. " + instruction +
            " Respondé en el MISMO idioma del texto original. Devolvé solo el texto resultante, en texto plano, " +
            "sin comillas, sin markdown, sin explicaciones ni introducciones.",
          parts: [{ text }],
          temperature: 0.4,
        });
        return json({ result });
      }

      case "translate": {
        const html = str(body.html, 80_000);
        if (!html) throw new HttpError(400, "No hay contrato para traducir.");
        const result = await ai({
          system:
            `Traducí el siguiente contrato en HTML al idioma: ${language}. ` +
            "Usá terminología jurídica correcta en ese idioma. Mantené EXACTAMENTE la misma estructura de etiquetas HTML y sus atributos class, " +
            "y dejá intactos los marcadores con la forma [[SIG0]], [[SIG1]], etc. y los espacios [__________]. " +
            "No traduzcas nombres propios de personas ni de empresas. Devolvé solo el HTML traducido, sin ``` ni explicaciones.",
          parts: [{ text: html }],
          temperature: 0.2,
        });
        return json({ result });
      }

      case "review": {
        const text = str(body.text, 40_000);
        if (text.length < 50) throw new HttpError(400, "El contrato es muy corto para revisarlo.");
        const result = await ai({
          system:
            "Sos una abogada revisora con mucha experiencia. Revisá el borrador de contrato que te pasan y respondé en JSON. " +
            `Escribí todos los textos en este idioma: ${language}. ` +
            "score: de 0 a 100 qué tan completo y equilibrado está. summary: 2 o 3 oraciones con tu opinión general. " +
            "plain: explicación del contrato en lenguaje muy sencillo, como se lo contarías a una amiga (máx. 120 palabras). " +
            "missing: cláusulas o datos importantes que faltan (máx. 6), cada una con title (nombre corto de la cláusula) y why. " +
            "risks: problemas, ambigüedades o cláusulas desequilibradas (máx. 6) con level (alta, media o baja), issue y suggestion. " +
            "Sé concreta y no inventes leyes específicas. Esto no reemplaza asesoría legal.",
          parts: [{ text }],
          temperature: 0.3,
          json: REVIEW_SCHEMA,
          think: true,
        });
        return json({ result });
      }

      case "clause": {
        const topic = str(body.topic, 200);
        if (!topic) throw new HttpError(400, "Falta el tema de la cláusula.");
        const result = await ai({
          system:
            `Redactá UNA cláusula de contrato en este idioma: ${language}. ` +
            "Empezá con su título en <h2> (sin número) y luego el texto en uno o más <p>. " +
            "Usá [__________] para datos que falten. " + HTML_RULES,
          parts: [{ text: `Contrato: ${str(body.title, 160)}\nCláusula a agregar: ${topic}\nMotivo: ${str(body.why, 400)}` }],
          temperature: 0.4,
        });
        return json({ result });
      }

      case "analyze": {
        const parts = [];
        if (body.file) {
          const mime = str(body.file.mime, 40);
          const data = typeof body.file.data === "string" ? body.file.data : "";
          if (!FILE_TYPES.includes(mime)) throw new HttpError(400, "Formato no soportado. Subí un PDF, una foto (JPG/PNG/WEBP) o un .txt.");
          if (!data || data.length > MAX_FILE_B64 || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(413, "El archivo es demasiado grande (máx. 3.5 MB).");
          if (mime === "text/plain") parts.push({ text: Buffer.from(data, "base64").toString("utf8").slice(0, 60_000) });
          else parts.push({ inlineData: { mimeType: mime, data } });
        } else {
          const text = str(body.text, 60_000);
          if (text.length < 50) throw new HttpError(400, "Subí un archivo o pegá el texto del contrato.");
          parts.push({ text });
        }
        parts.push({ text: "Analizá este documento." });
        const result = await ai({
          system:
            "Analizás contratos que otra persona le pide firmar a la usuaria, para protegerla. Respondé en JSON. " +
            `Escribí todos los textos en este idioma: ${language}. ` +
            "isContract: false si el documento claramente no es un contrato o acuerdo (en ese caso dejá las listas vacías y explicalo en summary). " +
            "title y kind (tipo de contrato). parties: quiénes firman y su rol. summary: resumen en lenguaje sencillo (máx. 100 palabras). " +
            "keyPoints: lo más importante que se compromete cada parte (máx. 8). dates: plazos y fechas clave. money: montos, pagos y multas. " +
            "redFlags: cláusulas peligrosas, abusivas, ambiguas o inusuales (máx. 8) con level (alta, media o baja), issue y why. " +
            "questions: preguntas que la usuaria debería hacer antes de firmar (máx. 6). Esto no reemplaza asesoría legal.",
          parts,
          temperature: 0.3,
          json: ANALYZE_SCHEMA,
          think: true,
        });
        return json({ result });
      }

      case "chat": {
        const msgs = (Array.isArray(body.messages) ? body.messages : [])
          .filter((m) => m && (m.role === "user" || m.role === "lacey") && typeof m.text === "string")
          .slice(-12)
          .map((m) => `${m.role === "user" ? "Usuaria" : "Lacey"}: ${m.text.trim().slice(0, 2000)}`);
        if (!msgs.length || !msgs[msgs.length - 1].startsWith("Usuaria:")) throw new HttpError(400, "Escribí tu pregunta.");
        const contract = str(body.contract, 30_000);
        const page = body.page && typeof body.page === "object" ? body.page : {};
        const state = [
          `Sesión iniciada: ${page.loggedIn ? "sí" : "no"}`,
          `Hay un contrato abierto: ${contract ? "sí" : "no"}`,
          page.title ? `Título del contrato: ${str(page.title, 160)}` : "",
          page.endDate ? `Vence el: ${str(page.endDate, 20)}` : "",
          Number.isFinite(page.pendingSignatures) ? `Firmas pendientes por link: ${page.pendingSignatures}` : "",
        ].filter(Boolean).join("\n");
        const result = await ai({
          system:
            "Sos Lacey, la asistente de Lacey Legal: una abogada joven, cálida, elegante y muy clara. " +
            `Respondé SIEMPRE en este idioma: ${language}. Hablás de forma cercana y amable, pero profesional. ` +
            "Nunca uses emojis. Sé breve: máximo 120 palabras, en párrafos cortos o una lista corta con guiones. " +
            "Si preguntan por el contrato abierto, basate solo en su texto y citá la cláusula cuando ayude; si algo no está en el contrato, decilo. " +
            "No inventes leyes ni artículos específicos. Para decisiones importantes o montos altos, recomendá con suavidad consultar a una abogada o abogado. " +
            "Si te piden algo fuera de contratos y de la app, redirigí con amabilidad. " +
            "mood: tu expresión al responder (feliz si es una buena noticia o un saludo, preocupada si hay un riesgo o problema, pensando si das una explicación o hay dudas, normal en otro caso). " +
            `actions: hasta 2 botones de la app que le servirían ahora (${CHAT_ACTIONS.join(", ")}). ` +
            "Usá 'tour' si pide que le muestres cómo funciona la página. Lista vacía si no aplica.\n\n" +
            LACEY_GUIDE,
          parts: [{
            text: `Estado de la página:\n${state}\n\n` +
              (contract ? `Contrato abierto:\n"""\n${contract}\n"""\n\n` : "") +
              `Conversación:\n${msgs.join("\n")}\nLacey:`,
          }],
          temperature: 0.6,
          json: CHAT_SCHEMA,
        });
        const reply = str(result?.reply, 2000);
        if (!reply) throw new HttpError(502, "Lacey no pudo responder. Intentá de nuevo.");
        const mood = ["normal", "feliz", "pensando", "preocupada"].includes(result.mood) ? result.mood : "normal";
        const actions = (Array.isArray(result.actions) ? result.actions : []).filter((a) => CHAT_ACTIONS.includes(a)).slice(0, 2);
        return json({ result: { reply, mood, actions } });
      }

      case "templatize": {
        const html = str(body.html, 120_000);
        if (html.length < 50) throw new HttpError(400, "El contrato es muy corto para convertirlo en plantilla.");
        const result = await ai({
          system:
            "Convertí este contrato en una plantilla reutilizable. Reemplazá cada dato concreto que cambiaría en otro contrato " +
            "(nombres de las partes, cédulas o identificaciones, direcciones, correos, teléfonos, montos, monedas, fechas, plazos específicos, " +
            "descripción puntual del servicio o bien) por un campo entre llaves con un nombre corto y claro, " +
            `escrito en este idioma: ${language}. Ejemplos: {nombre del cliente}, {monto}, {fecha de inicio}. ` +
            "Si el mismo dato aparece varias veces, usá exactamente el mismo campo. No cambies nada más del texto. " +
            "Si hay espacios [__________], convertilos también en campos. Quitá la sección de firmas si existe. " +
            "Devolvé SOLO el HTML con las mismas etiquetas, sin ``` ni explicaciones.",
          parts: [{ text: html }],
          temperature: 0.2,
        });
        return json({ result });
      }

      case "translateUI": {
        // Traducción de la interfaz: no cuenta en el límite diario (es la página, no tu contenido),
        // queda en caché para todas las personas y tiene su propio tope anti-abuso.
        const strings = Array.isArray(body.strings) ? body.strings.filter((s) => typeof s === "string").slice(0, 320) : [];
        if (!strings.length) throw new HttpError(400, "No hay textos para traducir.");
        if (strings.join("").length > 24_000) throw new HttpError(413, "Demasiado texto.");
        const cacheKey = `i18n/${language.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}/${(await sha256(JSON.stringify(strings))).slice(0, 32)}`;
        let store = null;
        try {
          store = storeFactory();
          const cached = await store.get(cacheKey, { type: "json" });
          if (Array.isArray(cached) && cached.length === strings.length) return json({ result: cached, cached: true });
        } catch {
          store = null; // sin Blobs (p. ej. local) traducimos igual
        }
        if (usageStore) {
          const uiKey = `ui_${usageKey}`;
          if ((await getUsage(usageStore, uiKey, now()).catch(() => 0)) >= 40) {
            throw new HttpError(429, "Probaste muchos idiomas hoy. Intentá de nuevo mañana.");
          }
          await addUsage(usageStore, uiKey, now()).catch(() => {});
        }
        const out = await model({
          system:
            `Traducí al idioma "${language}" el texto "s" de cada objeto del arreglo JSON. Es la interfaz de "Lacey Legal", ` +
            "una app web para crear y firmar contratos, con un tono cálido, cercano y profesional. " +
            'Respondé con un arreglo JSON de objetos {"i": número, "t": traducción}, uno por cada objeto recibido, con el mismo "i". ' +
            "No agregues emojis. Conservá tal cual las etiquetas HTML (<em>, <strong>, <br>), los marcadores entre llaves como {n} o {name}, " +
            "los signos y el nombre Lacey Legal.",
          parts: [{ text: JSON.stringify(strings.map((s, i) => ({ i, s }))) }],
          temperature: 0.2,
          json: S("ARRAY", { items: S("OBJECT", { properties: { i: S("INTEGER"), t: S("STRING") }, required: ["i", "t"] }) }),
        });
        // Alineamos por índice: si falta alguna, queda en el idioma original.
        const result = strings.slice();
        let got = 0;
        for (const r of Array.isArray(out) ? out : []) {
          if (Number.isInteger(r?.i) && r.i >= 0 && r.i < strings.length && typeof r.t === "string" && r.t.trim()) {
            result[r.i] = r.t;
            got++;
          }
        }
        if (got < strings.length * 0.6) throw new HttpError(502, "La traducción vino incompleta. Intentá de nuevo.");
        if (store && got === strings.length) await store.setJSON(cacheKey, result).catch(() => {});
        return json({ result, partial: got < strings.length });
      }

      default:
        throw new HttpError(400, "Acción no válida.");
    }
  });

export default makeHandler();

export const config = { path: ["/api/ai", "/api/usage"] };
