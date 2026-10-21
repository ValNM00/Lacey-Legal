// Traducción de la interfaz a cualquier idioma.
// El español es el idioma base. Para otros idiomas se toman todos los textos
// de la página (y los mensajes de M) y se traducen con IA una sola vez; el
// resultado queda en caché en el navegador y en el servidor.
import { M } from "./messages.js";
import { ai, sanitizeInline, store, $$ } from "./util.js";

export const LANGS = [
  ["Spanish", "Español"], ["English", "English"], ["Portuguese", "Português"], ["French", "Français"],
  ["Italian", "Italiano"], ["German", "Deutsch"], ["Dutch", "Nederlands"], ["Catalan", "Català"],
  ["Chinese (Simplified)", "中文 (简体)"], ["Chinese (Traditional)", "中文 (繁體)"], ["Japanese", "日本語"],
  ["Korean", "한국어"], ["Arabic", "العربية"], ["Hebrew", "עברית"], ["Russian", "Русский"],
  ["Ukrainian", "Українська"], ["Polish", "Polski"], ["Czech", "Čeština"], ["Romanian", "Română"],
  ["Greek", "Ελληνικά"], ["Turkish", "Türkçe"], ["Swedish", "Svenska"], ["Norwegian", "Norsk"],
  ["Danish", "Dansk"], ["Finnish", "Suomi"], ["Hungarian", "Magyar"], ["Hindi", "हिन्दी"],
  ["Bengali", "বাংলা"], ["Urdu", "اردو"], ["Persian", "فارسی"], ["Indonesian", "Bahasa Indonesia"],
  ["Malay", "Bahasa Melayu"], ["Vietnamese", "Tiếng Việt"], ["Thai", "ไทย"], ["Tagalog", "Tagalog"],
  ["Swahili", "Kiswahili"], ["Guarani", "Avañe'ẽ"], ["Quechua", "Runa Simi"],
];
export const RTL = ["Arabic", "Hebrew", "Urdu", "Persian"];
const CODES = {
  Spanish: "es", English: "en", Portuguese: "pt", French: "fr", Italian: "it", German: "de", Dutch: "nl",
  Catalan: "ca", "Chinese (Simplified)": "zh-Hans", "Chinese (Traditional)": "zh-Hant", Japanese: "ja", Korean: "ko",
  Arabic: "ar", Hebrew: "he", Russian: "ru", Ukrainian: "uk", Polish: "pl", Czech: "cs", Romanian: "ro", Greek: "el",
  Turkish: "tr", Swedish: "sv", Norwegian: "no", Danish: "da", Finnish: "fi", Hungarian: "hu", Hindi: "hi",
  Bengali: "bn", Urdu: "ur", Persian: "fa", Indonesian: "id", Malay: "ms", Vietnamese: "vi", Thai: "th",
  Tagalog: "tl", Swahili: "sw", Guarani: "gn", Quechua: "qu",
};

const PREF_KEY = "laceyLegal.uiLang";
const ATTRS = ["placeholder", "aria-label", "title"];

let lang = "Spanish";
let dict = null; // original → traducción
const textNodes = new Map(); // nodo → texto original
const htmlEls = new Map(); // elemento [data-i18n-html] → innerHTML original
const attrEls = []; // [elemento, atributo, original]
const listeners = new Set();
let collected = false;

export const getUILang = () => lang;
let lastError = null;
/** Último error al traducir la página (para mostrarlo). */
export const lastTranslateError = () => lastError?.message || "";
export const langCode = (name) => CODES[name] || "es";
export const onLangChange = (fn) => listeners.add(fn);

/** Traduce un mensaje de M. vars reemplaza {nombre}. */
export function t(key, vars) {
  const base = M[key] ?? key;
  let s = (dict && dict[base]) || base;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const hasLetters = (s) => /\p{L}/u.test(s);

function collect() {
  if (collected) return;
  collected = true;
  $$("[data-i18n-html]").forEach((el) => htmlEls.set(el, el.innerHTML.trim()));
  const skip = (el) => el.closest("[data-no-i18n], script, style, #doc, [data-i18n-html]");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement || skip(n.parentElement)) continue;
    if (hasLetters(n.nodeValue)) textNodes.set(n, n.nodeValue);
  }
  $$(ATTRS.map((a) => `[${a}]`).join(",")).forEach((el) => {
    if (el.closest("[data-no-i18n]")) return;
    ATTRS.forEach((a) => {
      const v = el.getAttribute(a);
      if (v && hasLetters(v)) attrEls.push([el, a, v]);
    });
  });
}

function sourceStrings() {
  const set = new Set();
  textNodes.forEach((v) => set.add(v.trim()));
  htmlEls.forEach((v) => set.add(v));
  attrEls.forEach(([, , v]) => set.add(v));
  Object.values(M).forEach((v) => set.add(v));
  set.delete("");
  return [...set];
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function apply() {
  const tr = (s) => (dict && dict[s]) || s;
  textNodes.forEach((orig, node) => {
    const core = orig.trim();
    const lead = orig.match(/^\s*/)[0];
    const trail = orig.match(/\s*$/)[0];
    node.nodeValue = lead + tr(core) + trail;
  });
  htmlEls.forEach((orig, el) => { el.innerHTML = dict ? sanitizeInline(tr(orig)) : orig; });
  attrEls.forEach(([el, a, orig]) => el.setAttribute(a, tr(orig)));
  const root = document.documentElement;
  root.lang = CODES[lang] || "es";
  root.dir = RTL.includes(lang) ? "rtl" : "ltr";
  listeners.forEach((fn) => fn(lang));
}

async function translateAll(target) {
  const strings = sourceStrings();
  const cacheKey = `laceyLegal.i18n.${target}.${hash(strings.join("\u0001"))}`;
  const cached = store.get(cacheKey);
  if (cached) return cached;
  // Pocos pedidos grandes, de a uno (Gemini gratis acepta pocas llamadas por minuto).
  const chunks = [];
  let chunk = [];
  let size = 0;
  for (const str of strings) {
    if (chunk.length && (size + str.length > 9000 || chunk.length >= 300)) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(str);
    size += str.length;
  }
  if (chunk.length) chunks.push(chunk);

  const map = {};
  let failed = 0;
  let lastError = null;
  for (const c of chunks) {
    let result = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await ai({ action: "translateUI", language: target, strings: c });
      } catch (err) {
        lastError = err;
        if (err.status === 400 || err.status === 413) break;
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    if (!result) { failed++; continue; }
    c.forEach((str, i) => { map[str] = result[i] || str; });
  }
  if (failed === chunks.length) throw lastError || new Error("translate-failed");
  if (!failed) store.set(cacheKey, map); // solo guardamos si salió completa
  return map;
}

/** Cambia el idioma de la interfaz. Devuelve false si falló. */
export async function setUILang(target, { onStart, onEnd } = {}) {
  collect();
  if (!target || target === "Spanish") {
    lang = "Spanish";
    dict = null;
    store.set(PREF_KEY, lang);
    apply();
    return true;
  }
  onStart?.();
  try {
    dict = await translateAll(target);
    lang = target;
    store.set(PREF_KEY, lang);
    apply();
    return true;
  } catch (err) {
    console.error(err);
    lastError = err;
    return false;
  } finally {
    onEnd?.();
  }
}

export function initI18n() {
  collect();
  return store.get(PREF_KEY, "Spanish");
}

export function fillLangSelect(sel, { withOther = true, value } = {}) {
  sel.innerHTML =
    LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("") +
    (withOther ? `<option value="__other">${t("otherLang")}</option>` : "");
  if (value) {
    if (!LANGS.some(([v]) => v === value)) sel.insertAdjacentHTML("afterbegin", `<option value="${value}">${value}</option>`);
    sel.value = value;
  }
}

/** Lee el idioma elegido; si es "otro", lo pregunta. */
export function readLang(sel, fallback = "Spanish") {
  if (sel.value !== "__other") return sel.value;
  const v = (prompt(t("askLang")) || "").trim().slice(0, 60);
  if (!v) { sel.value = fallback; return null; }
  if (![...sel.options].some((o) => o.value === v)) sel.insertAdjacentHTML("afterbegin", `<option value="${v.replace(/"/g, "")}">${v.replace(/</g, "")}</option>`);
  sel.value = v;
  return v;
}
