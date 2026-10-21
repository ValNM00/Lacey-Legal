// Dictado por voz: convierte lo que decís en texto dentro de un campo.
import { getUILang, langCode, t } from "./i18n.js";
import { toast } from "./util.js";

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const dictationSupported = !!Recognition;

let active = null; // { rec, button }

function stop() {
  if (!active) return;
  try { active.rec.stop(); } catch { /* ya estaba detenido */ }
  active.button.classList.remove("recording");
  active.button.setAttribute("aria-pressed", "false");
  active = null;
}

/** Conecta un botón de micrófono a un textarea/input. */
export function attachDictation(button, field) {
  if (!dictationSupported) {
    button.classList.add("hidden");
    return;
  }
  button.addEventListener("click", () => {
    if (active?.button === button) return stop();
    stop();
    const rec = new Recognition();
    rec.lang = langCode(getUILang());
    rec.interimResults = true;
    rec.continuous = true;
    const base = field.value && !/\s$/.test(field.value) ? field.value + " " : field.value;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      field.value = (base + finalText + interim).replace(/\s+$/, interim ? "" : " ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast(t("micDenied"), true);
      else if (e.error !== "aborted" && e.error !== "no-speech") toast(t("micError"), true);
      stop();
    };
    rec.onend = () => { if (active?.rec === rec) stop(); };
    try {
      rec.start();
      active = { rec, button };
      button.classList.add("recording");
      button.setAttribute("aria-pressed", "true");
      field.focus();
    } catch {
      toast(t("micError"), true);
    }
  });
}
