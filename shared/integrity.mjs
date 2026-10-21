// Huella digital del contrato (SHA-256 del texto, sin las firmas).
// La usan el servidor al registrar cada firma y el navegador al mostrar el
// certificado, para detectar si el texto cambió después de firmar.

const SIGNATURES_RE =
  /(?:<h2>[^<]*<\/h2>\s*)?<div class="signatures">(?:\s*<div class="sig-block">[\s\S]*?<\/div>\s*)*<\/div>/g;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Texto normalizado del contrato: sin firmas, sin etiquetas y con espacios uniformes. */
export function contractText(html) {
  return String(html || "")
    .replace(SIGNATURES_RE, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, " ")
    .trim();
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const documentHash = (html) => sha256(contractText(html));

const BLOCK_RE = /<div class="sig-block">[\s\S]*?<\/div>/g;
const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/<[^>]+>/g, " ").toLowerCase().replace(/\s+/g, " ").trim();

/** Cuántas firmas (con imagen) tiene el documento. Los espacios vacíos no cuentan. */
export const countSignatures = (html) => (String(html || "").match(BLOCK_RE) || []).filter((b) => b.includes("<img")).length;

/**
 * Pone una firma en el contrato: ocupa el espacio vacío que corresponde a esa persona
 * (por nombre o por rol); si no hay ninguno que coincida, el primer espacio libre;
 * y si el contrato no tiene espacios, agrega la sección de firmas al final.
 */
export function placeSignature(html, { block, name = "", role = "", heading = "Firmas" }) {
  html = String(html || "");
  const empties = [...html.matchAll(BLOCK_RE)].filter((m) => !m[0].includes("<img"));
  if (empties.length) {
    const n = fold(name);
    const r = fold(role);
    const first = (n && n.split(" ")[0]) || "";
    const pick =
      empties.find((m) => n && fold(m[0]).includes(n)) ||
      empties.find((m) => r && fold(m[0]).includes(r)) ||
      empties.find((m) => first.length > 2 && fold(m[0]).includes(first)) ||
      empties.find((m) => fold(m[0]).includes("_____")) ||
      empties[0];
    return html.slice(0, pick.index) + block + html.slice(pick.index + pick[0].length);
  }
  const area = html.lastIndexOf('<div class="signatures">');
  if (area >= 0) {
    // agrega dentro de la sección existente (antes de su cierre)
    const end = findAreaEnd(html, area);
    if (end > 0) return html.slice(0, end) + block + html.slice(end);
  }
  return `${html}<h2>${heading}</h2><div class="signatures">${block}</div>`;
}

/** Posición del </div> que cierra la sección de firmas que empieza en `start`. */
function findAreaEnd(html, start) {
  let depth = 0;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return -1;
}
