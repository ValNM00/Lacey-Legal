/* ───────────── Lacey Legal · página pública de firma (firmar.html) ───────────── */
import { $, toast, escapeHTML, sanitize, api, ai, cleanAIHtml, store } from "./util.js";
import { t, initI18n, setUILang, getUILang, onLangChange, fillLangSelect, readLang, RTL, langCode } from "./i18n.js";
import { createPad, signatureBlock } from "./signature-pad.js";
import { exportPDF } from "./exporters.js";

const token = location.hash.slice(1).replace(/[^a-f0-9]/g, "");
const docEl = $("#signDoc");
let data = null;
let originalHTML = "";
let selectedQuote = "";
const fmt = (ts) => new Date(ts).toLocaleString(langCode(getUILang()), { dateStyle: "medium", timeStyle: "short" });

function state(kind, extra = {}) {
  const box = $("#signState");
  const messages = {
    loading: t("loading"),
    invalid: t("signInvalid"),
    expired: t("signExpired"),
    signed: t("signAlready", { date: extra.date || "" }),
    error: extra.message || t("genericError"),
  };
  box.innerHTML = `<p>${escapeHTML(messages[kind])}</p>`;
  box.classList.remove("hidden");
}

function render() {
  $("#signIntro").innerHTML = escapeHTML(t("signIntro", { owner: data.ownerName || t("someone"), title: data.title }));
  $("#signIntro").classList.remove("hidden");
  docEl.innerHTML = sanitize(data.html);
  docEl.dir = RTL.includes(data.lang) ? "rtl" : "ltr";
  originalHTML = docEl.innerHTML;
  $("#docWrap").classList.remove("hidden");
}

async function load() {
  if (token.length !== 48) return state("invalid");
  state("loading");
  try {
    data = await api(`/api/sign/${token}`);
  } catch (err) {
    return state(err.status === 404 ? "invalid" : "error", { message: err.message });
  }
  $("#signState").classList.add("hidden");
  render();
  if (data.status === "expired") return state("expired");
  if (data.status === "signed") return state("signed", { date: new Date(data.signedAt).toLocaleDateString() });
  renderComments();
  $("#changesCard").classList.remove("hidden");
  if (data.status === "waiting") {
    $("#waitingCard").classList.remove("hidden");
    $("#waitingText").textContent = t("signWaiting", { names: data.waitingFor.join(", ") });
    return;
  }
  $("#sName").value = data.signerName || "";
  $("#sRole").textContent = data.role ? t("signingAs", { role: data.role }) : "";
  $("#signPanel").classList.remove("hidden");
  requestAnimationFrame(pad.reset);
}

// ───────── pedir cambios ─────────
function renderComments() {
  const list = data.comments || [];
  $("#myComments").innerHTML = list.map((c) => `<li class="comment ${c.status}">
      <div class="comment-head"><small>${escapeHTML(fmt(c.at))}</small>
        <span class="pill ${c.status === "open" ? "wait" : "ok"}">${escapeHTML(t(c.status === "open" ? "cmSent" : "cmResolved"))}</span></div>
      ${c.quote ? `<blockquote>${escapeHTML(c.quote)}</blockquote>` : ""}
      <p>${escapeHTML(c.text)}</p>
      ${c.reply ? `<div class="comment-reply"><small>${escapeHTML(t("cmOwnerReply", { owner: data.ownerName || t("someone") }))}</small><p>${escapeHTML(c.reply)}</p></div>` : ""}
    </li>`).join("");
  $("#myComments").classList.toggle("hidden", !list.length);
}

docEl.addEventListener("mouseup", captureQuote);
docEl.addEventListener("touchend", () => setTimeout(captureQuote, 50));
function captureQuote() {
  const sel = getSelection();
  const text = sel.rangeCount && docEl.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.toString().trim() : "";
  if (!text) return;
  selectedQuote = text.slice(0, 600);
  $("#quoteBox").textContent = selectedQuote;
  $("#quoteWrap").classList.remove("hidden");
  $("#changesForm").classList.remove("hidden");
}
$("#askChanges").addEventListener("click", () => {
  $("#changesForm").classList.toggle("hidden");
  $("#cText").focus();
});
$("#quoteClear").addEventListener("click", () => {
  selectedQuote = "";
  $("#quoteWrap").classList.add("hidden");
});
$("#cSend").addEventListener("click", async () => {
  const text = $("#cText").value.trim();
  if (text.length < 2) return toast(t("cmNeedText"), true);
  const btn = $("#cSend");
  btn.disabled = true;
  try {
    const r = await api(`/api/sign/${token}/comment`, { method: "POST", body: { text, quote: selectedQuote } });
    data.comments = [...(data.comments || []), r.comment];
    renderComments();
    $("#cText").value = "";
    selectedQuote = "";
    $("#quoteWrap").classList.add("hidden");
    $("#changesForm").classList.add("hidden");
    toast(t("cmSentToast", { owner: data.ownerName || t("someone") }));
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

const pad = createPad($("#sPad"), $("#sHint"));
$("#sClear").addEventListener("click", pad.reset);
window.addEventListener("resize", () => !pad.hasInk() && pad.reset());

$("#sSubmit").addEventListener("click", async () => {
  const name = $("#sName").value.trim();
  if (!name) return toast(t("needFullName"), true);
  if (!pad.hasInk()) return toast(t("needInk"), true);
  if (!$("#sAgree").checked) return toast(t("needAgree"), true);
  const btn = $("#sSubmit");
  btn.disabled = true;
  try {
    const png = pad.toPNG();
    const { signedAt } = await api(`/api/sign/${token}`, { method: "POST", body: { name, signature: png, agree: true } });
    // Mostramos el contrato original con la firma agregada.
    docEl.innerHTML = originalHTML;
    let area = docEl.querySelector(".signatures:last-of-type");
    if (!area) {
      const h = document.createElement("h2");
      h.textContent = t("signaturesHeading");
      area = document.createElement("div");
      area.className = "signatures";
      docEl.append(h, area);
    }
    const date = new Date(signedAt).toISOString().slice(0, 10);
    area.append(signatureBlock({ png, name, meta: `${data.role ? data.role + " · " : ""}${date} · ${t("eSignature")}` }));
    $("#signPanel").classList.add("hidden");
    $("#changesCard").classList.add("hidden");
    $("#signDone").classList.remove("hidden");
    toast(t("signedOk"));
    $("#signDone").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("#sPdf").addEventListener("click", async () => {
  try { await exportPDF(docEl); } catch (err) { toast(t("pdfFailed") + " " + err.message, true); }
});

// Leer el contrato traducido (solo para entenderlo; se firma el original).
$("#readBtn").addEventListener("click", async () => {
  if (!data) return;
  const lang = readLang($("#readLang"));
  if (!lang) return;
  const btn = $("#readBtn");
  btn.disabled = true;
  try {
    const clone = document.createElement("div");
    clone.innerHTML = originalHTML;
    const imgs = [];
    clone.querySelectorAll("img").forEach((img, i) => { imgs.push(img.outerHTML); img.replaceWith(`[[SIG${i}]]`); });
    let html = cleanAIHtml(await ai({ action: "translate", html: clone.innerHTML, language: lang }));
    imgs.forEach((tag, i) => { html = html.replace(`[[SIG${i}]]`, tag); });
    docEl.innerHTML = sanitize(html);
    docEl.dir = RTL.includes(lang) ? "rtl" : "ltr";
    $("#translatedNote").classList.remove("hidden");
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
$("#showOriginal").addEventListener("click", () => {
  docEl.innerHTML = originalHTML;
  docEl.dir = RTL.includes(data?.lang) ? "rtl" : "ltr";
  $("#translatedNote").classList.add("hidden");
});

// Tema e idioma de la interfaz (mismas preferencias que el sitio principal)
document.documentElement.dataset.theme = store.get("laceyLegal.theme", "rosa");
const pref = initI18n();
fillLangSelect($("#uiLang"), { value: "Spanish" });
fillLangSelect($("#readLang"), { value: "English" });
$("#uiLang").addEventListener("change", async () => {
  const v = readLang($("#uiLang"), getUILang());
  if (!v) return;
  toast(t("uiTranslating"));
  if (!(await setUILang(v))) toast(t("uiTranslateFailed"), true);
  $("#uiLang").value = getUILang();
});
onLangChange(() => {
  fillLangSelect($("#uiLang"), { value: getUILang() });
  fillLangSelect($("#readLang"), { value: $("#readLang").value });
  if (data) {
    $("#signIntro").textContent = t("signIntro", { owner: data.ownerName || t("someone"), title: data.title });
    $("#sRole").textContent = data.role ? t("signingAs", { role: data.role }) : "";
  }
});
if (pref && pref !== "Spanish") setUILang(pref).then(() => ($("#uiLang").value = getUILang()));
load();
