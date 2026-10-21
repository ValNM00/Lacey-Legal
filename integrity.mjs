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

/** Cuántas firmas tiene el documento. */
export const countSignatures = (html) => (String(html || "").match(/class="sig-block"/g) || []).length;
