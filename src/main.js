/* ───────────── Lacey Legal · aplicación principal ───────────── */
import {
  $, $$, toast, escapeHTML, sanitize, cleanAIHtml, ai, debounce, uid, store,
  fileToBase64, daysLeft, openDialog, closeDialog,
} from "./util.js";
import { t, initI18n, setUILang, getUILang, onLangChange, fillLangSelect, readLang, RTL, langCode } from "./i18n.js";
import { initAuth, onUser, currentUser, openAuth, authAvailable } from "./auth.js";
import { localLib, cloudLib, ConflictError, localTemplates, cloudTemplates, localProfile, cloudProfile } from "./storage.js";
import { createPad, signatureBlock } from "./signature-pad.js";
import { exportPDF, exportDocx, downloadICS } from "./exporters.js";
import { initLacey, react, setMood, startTour } from "./assistant.js";
import { initDashboard, renderDashboard, renderTemplates, showTemplatesTab } from "./dashboard.js";
import { initTemplates } from "./templates-ui.js";
import { initCollab, renderShares, updateCommentsBadge, certificateFor, integrityWarning } from "./collab.js";
import { initSettings, openSettings } from "./settings.js";
import { attachDictation } from "./dictation.js";
import { diffWords, diffStats, renderDiff, htmlToText } from "./diff.js";

const TYPE_IDS = [
  "servicios", "pago", "nda", "mantenimiento", "contratista",
  "arrendamiento", "compraventa", "colaboracion", "eventos", "personalizado",
];
const BOW_SVG = '<svg class="bow-svg" viewBox="0 0 64 40" aria-hidden="true"><path d="M32 20C22 6 6 6 6 16s16 12 26 4Z"/><path d="M32 20C42 6 58 6 58 16s-16 12-26 4Z"/><path d="M30 22 21 38l6-2 5-12Z"/><path d="M34 22l9 16-6-2-5-12Z"/><circle cx="32" cy="20" r="5"/></svg>';
const AUTO_VERSION_MS = 5 * 60 * 1000;

const doc = $("#doc");
let lib = localLib;
let cur = null; // { id, title, lang, folder, updated, endDate, remindDays, remindEmail, audit, comments }
let profile = {};
let pendingAudit = null; // evento de auditoría para el próximo guardado (firma hecha aquí)
let list = [];
let selectedType = "servicios";
let activeTab = "describe";
let savedRange = null;
let busy = false;
let lastVersionAt = 0;
let lastEditAt = 0;
let dirty = false;
let saveChain = Promise.resolve();

// ───────────────────────── básicos del editor ─────────────────────────
function setBusy(on, text) {
  busy = on;
  $("#loading").classList.toggle("hidden", !on);
  if (text) $("#loadingText").textContent = text;
  $$("#generateBtn, .tool").forEach((b) => (b.disabled = on));
  doc.setAttribute("contenteditable", on ? "false" : "true");
}

const docIsEmpty = () => doc.classList.contains("empty");

function setDocHTML(html, lang) {
  doc.classList.remove("empty");
  doc.innerHTML = sanitize(html);
  doc.dataset.lang = lang || doc.dataset.lang || "Spanish";
  doc.dir = RTL.includes(doc.dataset.lang) ? "rtl" : "ltr";
}

function renderEmptyDoc() {
  doc.classList.add("empty");
  doc.dir = "ltr";
  doc.innerHTML = `<div class="empty-state" contenteditable="false"><div class="empty-bow">${BOW_SVG}</div>
    <p><strong>${escapeHTML(t("emptyTitle"))}</strong></p><p>${escapeHTML(t("emptyText"))}</p></div>`;
}

function resetDoc() {
  cur = null;
  renderEmptyDoc();
  setStatus("");
  renderDashboard();
  updateCommentsBadge();
}

function setStatus(text) {
  $("#saveStatus").textContent = text;
}

const requireDoc = () => {
  if (docIsEmpty()) {
    toast(t("needContract"), true);
    return false;
  }
  return true;
};

const timeStr = (ts) => new Date(ts).toLocaleString(langCode(getUILang()), { dateStyle: "medium", timeStyle: "short" });

// ───────────────────────── guardar / abrir ─────────────────────────
function save(opts = {}) {
  saveChain = saveChain.then(() => doSave(opts)).catch(() => {});
  return saveChain;
}

async function doSave({ version, silent = false } = {}) {
  if (docIsEmpty()) {
    if (!silent) toast(t("nothingToSave"), true);
    return;
  }
  if (!cur) cur = { id: uid(), endDate: "", remindDays: 7, remindEmail: false, updated: null };
  cur.title = (doc.querySelector("h1")?.textContent || t("untitled")).trim().slice(0, 150);
  cur.lang = doc.dataset.lang || "Spanish";
  if (!version && Date.now() - lastVersionAt > AUTO_VERSION_MS && cur.updated) version = t("vAuto");
  try {
    const auditEvent = pendingAudit;
    pendingAudit = null;
    const { updated } = await lib.save({ ...cur, html: doc.innerHTML, auditEvent }, { version, base: cur.updated });
    if (auditEvent && lib.kind === "cloud") cur.audit = [...(cur.audit || []), { ...auditEvent, at: Date.now() }];
    cur.updated = updated;
    dirty = false;
    if (version) lastVersionAt = Date.now();
    setStatus(t(lib.kind === "cloud" ? "savedCloud" : "savedLocal", { time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
    if (!silent) toast(t("saved"));
    await refreshList();
  } catch (err) {
    if (err instanceof ConflictError) {
      openContract(err.latest);
      toast(t("conflictLoaded"), true);
    } else if (err.message === "storage-full") {
      toast(t("storageFull"), true);
    } else {
      setStatus(t("saveFailed"));
      if (err.status === 401) openAuth(t("sessionExpired"));
      else toast(err.message, true);
    }
  }
}

function openContract(c) {
  cur = {
    id: c.id, title: c.title, lang: c.lang, folder: c.folder || "", updated: c.updated,
    endDate: c.endDate || "", remindDays: c.remindDays ?? 7, remindEmail: !!c.remindEmail,
    audit: c.audit || [], comments: c.comments || [],
  };
  setDocHTML(c.html, c.lang);
  lastVersionAt = Date.now();
  dirty = false;
  setStatus(t("openedAt", { time: timeStr(c.updated) }));
  renderDashboard();
  renderDueBanner();
  updateCommentsBadge();
}

/** Crea un contrato nuevo a partir de HTML (plantillas, duplicados). */
async function createContract({ html, lang, version, folder = "", open = true }) {
  if (open && cur && !docIsEmpty()) await save({ silent: true });
  const c = { id: uid(), title: "", html: sanitize(html), lang: lang || "Spanish", folder, endDate: "", remindDays: 7, remindEmail: false };
  const div = document.createElement("div");
  div.innerHTML = c.html;
  c.title = (div.querySelector("h1")?.textContent || t("untitled")).trim().slice(0, 150);
  if (open) {
    cur = { ...c, updated: null, audit: [], comments: [] };
    setDocHTML(c.html, c.lang);
    await save({ version, silent: true });
    $(".editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    await lib.save(c, { version });
    await refreshList();
  }
}

async function openFromList(id) {
  if (cur && !docIsEmpty() && cur.id !== id) await save({ silent: true });
  await loadContract(id);
}

async function loadContract(id) {
  try {
    const c = await lib.get(id);
    if (!c) return toast(t("notFound"), true);
    openContract(c);
    $(".editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    toast(err.message, true);
  }
}

async function refreshList() {
  try {
    list = await lib.list();
  } catch (err) {
    if (err.status === 401) list = [];
    else console.error(err);
  }
  renderDashboard();
  renderDueBanner();
  if ($("#shareModal").open) renderShares();
}

// ───────────────────────── tipos y pestañas ─────────────────────────
function renderTypes() {
  $("#typeChips").innerHTML = TYPE_IDS.map((id) =>
    `<button type="button" class="chip" role="radio" aria-checked="${id === selectedType}" data-type="${id}">${escapeHTML(t("type_" + id))}</button>`
  ).join("");
  $("#typeGrid").innerHTML = TYPE_IDS.map((id) =>
    `<button type="button" class="type-card" data-type="${id}"><h3>${escapeHTML(t("type_" + id))}</h3><p>${escapeHTML(t("type_" + id + "_d"))}</p></button>`
  ).join("");
}

$("#typeChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  selectedType = b.dataset.type;
  renderTypes();
});
$("#typeGrid").addEventListener("click", (e) => {
  const b = e.target.closest(".type-card");
  if (!b) return;
  selectedType = b.dataset.type;
  renderTypes();
  $("#crear").scrollIntoView({ behavior: "smooth" });
  setTimeout(() => $(activeTab === "describe" ? "#prompt" : "#fA").focus({ preventScroll: true }), 500);
});

$$(".input-card .tab").forEach((tab) => tab.addEventListener("click", () => {
  activeTab = tab.dataset.tab;
  $$(".input-card .tab").forEach((x) => { const on = x === tab; x.classList.toggle("active", on); x.setAttribute("aria-selected", on); });
  $("#panel-describe").classList.toggle("hidden", activeTab !== "describe");
  $("#panel-guided").classList.toggle("hidden", activeTab !== "guided");
}));

$$(".examples .example").forEach((b) => b.addEventListener("click", () => {
  $("#prompt").value = b.textContent.trim();
  $("#prompt").focus();
}));

// ───────────────────────── generar ─────────────────────────
function guidedText() {
  const v = (id) => $(id).value.trim();
  const clauses = $$(".checks input:checked").map((c) => c.value);
  const p = [];
  if (v("#fA")) p.push(`Parte A: ${v("#fA")}${v("#fArole") ? ` (${v("#fArole")})` : ""}`);
  if (v("#fB")) p.push(`Parte B: ${v("#fB")}${v("#fBrole") ? ` (${v("#fBrole")})` : ""}`);
  if (v("#fObject")) p.push(`Objeto: ${v("#fObject")}`);
  if (v("#fAmount")) p.push(`Monto: ${v("#fAmount")} ${$("#fCurrency").value}`);
  if (v("#fStart")) p.push(`Fecha de inicio: ${v("#fStart")}`);
  if (v("#fEnd")) p.push(`Fecha de finalización: ${v("#fEnd")}`);
  if (v("#fCountry")) p.push(`País / jurisdicción: ${v("#fCountry")}`);
  if (clauses.length) p.push(`Incluir cláusulas de: ${clauses.join(", ")}`);
  if (v("#fNotes")) p.push(`Notas: ${v("#fNotes")}`);
  return p.join("\n");
}

$("#generateBtn").addEventListener("click", async () => {
  if (busy) return;
  let details = activeTab === "describe" ? $("#prompt").value.trim() : guidedText();
  if (details.length < 8) return toast(t(activeTab === "describe" ? "needDetails" : "needGuided"), true);
  if (profile.name && $("#usePartyA").checked && !$("#partyAWrap").classList.contains("hidden")) {
    details += "\n\nUna de las partes es quien usa la app: " +
      [profile.name, profile.idNumber && `identificación ${profile.idNumber}`, profile.address && `domicilio ${profile.address}`,
        profile.email && `correo ${profile.email}`, profile.phone && `teléfono ${profile.phone}`].filter(Boolean).join(", ") + ".";
  }
  const lang = readLang($("#outLang"));
  if (!lang) return;
  setBusy(true, t("writing"));
  setMood("pensando");
  try {
    const html = await ai({ action: "generate", contractType: t("type_" + selectedType), details, language: lang });
    if (cur && !docIsEmpty()) await save({ silent: true });
    cur = {
      id: uid(), updated: null, remindDays: 7, remindEmail: false, folder: "", audit: [], comments: [],
      endDate: activeTab === "guided" ? $("#fEnd").value : "",
    };
    setDocHTML(cleanAIHtml(html), lang);
    await save({ version: t("vGenerated"), silent: true });
    $(".editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
    if (!react("feliz", t("lc_generated"), { actions: ["review"] })) toast(t("ready"));
  } catch (err) {
    aiFailed(err);
  } finally {
    setBusy(false);
  }
});

// ───────────────────────── IA sobre la selección ─────────────────────────
function captureSelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!doc.contains(range.commonAncestorContainer) || range.collapsed) return null;
  return range.cloneRange();
}
document.addEventListener("selectionchange", () => {
  const r = captureSelection();
  if (r) savedRange = r;
});
$(".toolbar").addEventListener("mousedown", (e) => {
  if (e.target.closest(".ai-tool")) e.preventDefault(); // no perder la selección
});

$$(".ai-tool").forEach((btn) => btn.addEventListener("click", async () => {
  if (busy || !requireDoc()) return;
  const range = captureSelection() || savedRange;
  const text = range ? range.toString().trim() : "";
  if (!text) return toast(t("needSelection"), true);
  if (text.length > 8000) return toast(t("selectionTooLong"), true);
  setBusy(true, t("mode_" + btn.dataset.mode));
  setMood("pensando");
  try {
    const result = await ai({ action: "rewrite", mode: btn.dataset.mode, text });
    range.deleteContents();
    range.insertNode(document.createTextNode(result.trim()));
    savedRange = null;
    window.getSelection().removeAllRanges();
    await save({ version: t("vAIEdit"), silent: true });
    setMood("feliz");
    toast(t("textUpdated"));
  } catch (err) {
    aiFailed(err);
  } finally {
    setBusy(false);
  }
}));

// ───────────────────────── traducir el contrato ─────────────────────────
$("#translateBtn").addEventListener("click", async () => {
  if (busy || !requireDoc()) return;
  const lang = readLang($("#transLang"));
  if (!lang) return;
  const clone = doc.cloneNode(true);
  const imgs = [];
  $$("img", clone).forEach((img, i) => { imgs.push(img.outerHTML); img.replaceWith(`[[SIG${i}]]`); });
  setBusy(true, t("translating"));
  setMood("pensando");
  try {
    let html = cleanAIHtml(await ai({ action: "translate", html: clone.innerHTML, language: lang }));
    imgs.forEach((tag, i) => { html = html.replace(`[[SIG${i}]]`, tag); });
    setDocHTML(html, lang);
    await save({ version: t("vTranslated", { lang: $("#transLang").selectedOptions[0]?.textContent || lang }), silent: true });
    setMood("feliz");
    toast(t("translated"));
  } catch (err) {
    aiFailed(err);
  } finally {
    setBusy(false);
  }
});

// ───────────────────────── firmar aquí ─────────────────────────
const signModal = $("#signModal");
const pad = createPad($("#signPad"), $("#padHint"));

$("#signBtn").addEventListener("click", () => {
  if (!requireDoc()) return;
  $("#signName").value = currentUser()?.name || "";
  $("#signRole").value = "";
  openDialog(signModal);
  requestAnimationFrame(pad.reset);
});
$("#clearPad").addEventListener("click", pad.reset);
$("#cancelSign").addEventListener("click", () => closeDialog(signModal));

function appendSignature(block) {
  let area = $(".signatures", doc);
  if (!area) {
    const h = document.createElement("h2");
    h.textContent = t("signaturesHeading");
    area = document.createElement("div");
    area.className = "signatures";
    doc.append(h, area);
  }
  area.append(block);
}

$("#confirmSign").addEventListener("click", async () => {
  const name = $("#signName").value.trim();
  if (!name) return toast(t("needSignerName"), true);
  if (!pad.hasInk()) return toast(t("needInk"), true);
  const role = $("#signRole").value.trim();
  appendSignature(signatureBlock({ png: pad.toPNG(), name, meta: `${role ? role + " · " : ""}${new Date().toLocaleDateString()}` }));
  closeDialog(signModal);
  pendingAudit = { type: "signed-here", name, role };
  await save({ version: t("vSigned", { name }), silent: true });
  if (!react("feliz", t("lc_signedHere"), { actions: currentUser() ? ["share"] : [] })) toast(t("signatureAdded"));
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("copied"));
  } catch {
    toast(t("copyFailed"), true);
  }
}
// Cuando hay links pendientes, revisamos cada tanto si la otra parte ya firmó.
setInterval(async () => {
  if (lib.kind !== "cloud" || !cur || document.hidden || busy) return;
  const meta = list.find((x) => x.id === cur.id);
  if (!meta?.shares?.some((s) => s.status === "pending")) return;
  const before = new Set(meta.shares.filter((s) => s.status === "signed").map((s) => s.token));
  const commentsBefore = meta.openComments || 0;
  await refreshList();
  const now = list.find((x) => x.id === cur?.id);
  if (!now) return;
  const newly = (now?.shares || []).filter((s) => s.status === "signed" && !before.has(s.token));
  if ((now.openComments || 0) > commentsBefore && !newly.length) {
    const latest = await lib.get(cur.id);
    if (latest && cur?.id === latest.id) {
      const known = new Set((cur.comments || []).map((c) => c.id));
      cur.comments = latest.comments || [];
      cur.audit = latest.audit || [];
      updateCommentsBadge();
      const fresh = cur.comments.filter((c) => !known.has(c.id));
      if (fresh.length) react("pensando", t("lc_commentNew", { name: fresh[0].name }), { actions: [{ label: t("seeComments"), run: () => $("#commentsBtn").click() }] });
    }
  }
  if (newly.length && Date.now() - lastEditAt > 3000) {
    if (dirty) await save({ silent: true }); // si había cambios sin guardar → conflicto → carga la versión firmada
    const latest = await lib.get(cur.id);
    if (latest && cur && latest.updated !== cur.updated) openContract(latest);
    newly.forEach((s) => {
      const name = s.signedName || s.signerName;
      if (!react("feliz", t("lc_remoteSigned", { name }), { actions: ["pdf"] })) toast(t("remoteSigned", { name }));
    });
  }
}, 20000);

// ───────────────────────── revisión con IA ─────────────────────────
const reviewModal = $("#reviewModal");
const LEVEL = { alta: "high", media: "mid", baja: "low" };

$("#reviewBtn").addEventListener("click", async () => {
  if (busy || !requireDoc()) return;
  setBusy(true, t("reviewing"));
  setMood("leyendo");
  try {
    const r = await ai({ action: "review", text: doc.innerText, language: getUILang() });
    const score = Math.max(0, Math.min(100, Number(r.score) || 0));
    $("#reviewBody").innerHTML = `
      <div class="score-row">
        <div class="score" style="--p:${score}"><span>${score}</span></div>
        <p>${escapeHTML(r.summary)}</p>
      </div>
      <details class="plain" open><summary>${escapeHTML(t("plainTitle"))}</summary><p>${escapeHTML(r.plain)}</p></details>
      <h3>${escapeHTML(t("missingTitle"))}</h3>
      <ul class="findings">${(r.missing || []).map((m, i) => `<li>
        <div><strong>${escapeHTML(m.title)}</strong><p>${escapeHTML(m.why)}</p></div>
        <button type="button" class="btn btn-soft btn-sm" data-clause="${i}">${escapeHTML(t("addClause"))}</button></li>`).join("")
        || `<li class="muted">${escapeHTML(t("nothingMissing"))}</li>`}</ul>
      <h3>${escapeHTML(t("risksTitle"))}</h3>
      <ul class="findings">${(r.risks || []).map((x) => `<li><span class="level ${LEVEL[x.level] || "mid"}">${escapeHTML(t("level_" + (LEVEL[x.level] || "mid")))}</span>
        <div><strong>${escapeHTML(x.issue)}</strong><p>${escapeHTML(x.suggestion)}</p></div></li>`).join("")
        || `<li class="muted">${escapeHTML(t("noRisks"))}</li>`}</ul>
      <p class="fineprint">${escapeHTML(t("notLegalAdvice"))}</p>`;
    reviewModal._missing = r.missing || [];
    const serious = (r.risks || []).filter((x) => x.level === "alta").length;
    setMood(serious ? "preocupada" : "feliz");
    openDialog(reviewModal);
  } catch (err) {
    aiFailed(err);
  } finally {
    setBusy(false);
  }
});
$("#closeReview").addEventListener("click", () => closeDialog(reviewModal));

$("#reviewBody").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-clause]");
  if (!b) return;
  const m = reviewModal._missing[Number(b.dataset.clause)];
  b.disabled = true;
  b.textContent = t("adding");
  try {
    const html = sanitize(cleanAIHtml(await ai({
      action: "clause", topic: m.title, why: m.why, title: cur?.title || "", language: doc.dataset.lang || "Spanish",
    })));
    const frag = document.createRange().createContextualFragment(html);
    const sigs = $(".signatures", doc);
    const before = sigs?.previousElementSibling?.tagName === "H2" ? sigs.previousElementSibling : sigs;
    before ? doc.insertBefore(frag, before) : doc.append(frag);
    b.textContent = t("added");
    await save({ version: t("vClause", { name: m.title }), silent: true });
  } catch (err) {
    b.disabled = false;
    b.textContent = t("addClause");
    toast(err.message, true);
  }
});

// ───────────────────────── analizar un contrato subido ─────────────────────────
let pickedFile = null;
const MAX_FILE = 3.5 * 1024 * 1024;

function pickFile(file) {
  if (!file) return;
  const okType = /^(application\/pdf|image\/(png|jpeg|webp)|text\/plain)$/.test(file.type);
  if (!okType) return toast(t("badFileType"), true);
  if (file.size > MAX_FILE) return toast(t("fileTooBig"), true);
  pickedFile = file;
  $("#dropLabel").textContent = `${file.name}`;
}
$("#fileInput").addEventListener("change", (e) => pickFile(e.target.files[0]));
const drop = $("#dropZone");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));

$("#analyzeBtn").addEventListener("click", async () => {
  const text = $("#analyzeText").value.trim();
  if (!pickedFile && text.length < 50) return toast(t("needFileOrText"), true);
  const btn = $("#analyzeBtn");
  const out = $("#analysisResult");
  btn.disabled = true;
  out.classList.remove("hidden");
  out.innerHTML = `<div class="loading-inline"><div class="spinner"></div><p>${escapeHTML(t("analyzing"))}</p></div>`;
  setMood("leyendo");
  try {
    const payload = { action: "analyze", language: getUILang() };
    if (pickedFile) payload.file = { mime: pickedFile.type, data: await fileToBase64(pickedFile) };
    else payload.text = text;
    const r = await ai(payload);
    const li = (arr) => (arr || []).map((x) => `<li>${escapeHTML(x)}</li>`).join("") || `<li class="muted">—</li>`;
    out.innerHTML = `
      <div class="analysis-head"><span class="eyebrow">${escapeHTML(r.kind || "")}</span><h3>${escapeHTML(r.title || t("analysisTitle"))}</h3>
        <p>${escapeHTML(r.summary)}</p></div>
      ${r.isContract === false ? "" : `
      <div class="analysis-grid">
        <section><h4>${escapeHTML(t("parties"))}</h4><ul>${li(r.parties)}</ul></section>
        <section><h4>${escapeHTML(t("dates"))}</h4><ul>${li(r.dates)}</ul></section>
        <section><h4>${escapeHTML(t("money"))}</h4><ul>${li(r.money)}</ul></section>
        <section><h4>${escapeHTML(t("keyPoints"))}</h4><ul>${li(r.keyPoints)}</ul></section>
      </div>
      <h4>${escapeHTML(t("redFlags"))}</h4>
      <ul class="findings">${(r.redFlags || []).map((x) => `<li><span class="level ${LEVEL[x.level] || "mid"}">${escapeHTML(t("level_" + (LEVEL[x.level] || "mid")))}</span>
        <div><strong>${escapeHTML(x.issue)}</strong><p>${escapeHTML(x.why)}</p></div></li>`).join("") || `<li class="muted">${escapeHTML(t("noRedFlags"))}</li>`}</ul>
      <h4>${escapeHTML(t("questions"))}</h4><ul>${li(r.questions)}</ul>`}
      <div class="analysis-actions"><button type="button" class="btn btn-soft" id="copyAnalysis">${escapeHTML(t("copyAnalysis"))}</button></div>
      <p class="fineprint">${escapeHTML(t("notLegalAdvice"))}</p>`;
    $("#copyAnalysis").addEventListener("click", () => {
      const clone = out.cloneNode(true);
      clone.querySelector(".analysis-actions")?.remove();
      document.body.append(clone); // innerText necesita el elemento en la página
      const text = clone.innerText.trim();
      clone.remove();
      copyText(text);
    });
    const flags = (r.redFlags || []).filter((x) => x.level === "alta").length;
    if (r.isContract === false) react("pensando", t("lc_notContract"));
    else if (flags) react("preocupada", t("lc_analysisFlags", { n: flags }));
    else react("feliz", t("lc_analysisOk"));
  } catch (err) {
    out.innerHTML = `<p class="error-text">${escapeHTML(err.message)}</p>`;
    setMood("preocupada");
  } finally {
    btn.disabled = false;
  }
});

// ───────────────────────── vencimiento y recordatorios ─────────────────────────
const dueModal = $("#dueModal");

$("#dueBtn").addEventListener("click", () => {
  if (!requireDoc()) return;
  if (!cur) cur = { id: uid(), updated: null, endDate: "", remindDays: 7, remindEmail: false };
  $("#dueDate").value = cur.endDate || "";
  $("#dueDays").value = String(cur.remindDays ?? 7);
  const logged = !!currentUser();
  $("#dueEmail").checked = logged && !!cur.remindEmail;
  $("#dueEmail").disabled = !logged;
  $("#dueEmailHint").textContent = logged ? t("emailTo", { email: currentUser().email }) : t("loginForEmail");
  openDialog(dueModal);
});
$("#closeDue").addEventListener("click", () => closeDialog(dueModal));
$("#saveDue").addEventListener("click", async () => {
  cur.endDate = $("#dueDate").value;
  cur.remindDays = Number($("#dueDays").value);
  cur.remindEmail = $("#dueEmail").checked && !!cur.endDate;
  closeDialog(dueModal);
  await save({ silent: true });
  toast(cur.endDate ? t("dueSaved") : t("dueRemoved"));
});
$("#icsBtn").addEventListener("click", () => {
  const endDate = $("#dueDate").value;
  if (!endDate) return toast(t("needDate"), true);
  downloadICS({ title: (doc.querySelector("h1")?.textContent || t("untitled")).trim(), endDate, remindDays: Number($("#dueDays").value) });
});

function dueText(days) {
  if (days < 0) return t("expired", { n: -days });
  if (days === 0) return t("dueToday");
  if (days === 1) return t("dueTomorrow");
  return t("dueIn", { n: days });
}

function renderDueBanner() {
  const due = list
    .map((c) => ({ c, d: daysLeft(c.endDate) }))
    .filter(({ c, d }) => d !== null && d >= -7 && d <= (c.remindDays ?? 7))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  const banner = $("#dueBanner");
  banner.classList.toggle("hidden", !due.length);
  banner.innerHTML = due.map(({ c, d }) =>
    `<button type="button" class="due-item ${d < 0 ? "late" : ""}" data-open="${escapeHTML(c.id)}"><strong>${escapeHTML(c.title)}</strong> · ${escapeHTML(dueText(d))}</button>`
  ).join("");
}
$("#dueBanner").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b) loadContract(b.dataset.open);
});

// ───────────────────────── versiones ─────────────────────────
const versionsModal = $("#versionsModal");

$("#versionsBtn").addEventListener("click", async () => {
  if (!requireDoc()) return;
  if (!cur?.updated) await save({ silent: true });
  $("#versionPreview").classList.add("hidden");
  $("#diffLegend").classList.add("hidden");
  $("#versionList").innerHTML = `<li class="muted">${escapeHTML(t("loading"))}</li>`;
  openDialog(versionsModal);
  try {
    const vs = await lib.versions(cur.id);
    $("#versionList").innerHTML = vs.length
      ? vs.map((v) => `<li><div><strong>${escapeHTML(v.label)}</strong><small>${escapeHTML(timeStr(v.at))}</small></div>
          <button type="button" class="tool" data-view="${escapeHTML(v.id)}">${escapeHTML(t("view"))}</button>
          <button type="button" class="tool" data-compare="${escapeHTML(v.id)}">${escapeHTML(t("compare"))}</button>
          <button type="button" class="tool" data-restore="${escapeHTML(v.id)}">${escapeHTML(t("restore"))}</button></li>`).join("")
      : `<li class="muted">${escapeHTML(t("noVersions"))}</li>`;
  } catch (err) {
    $("#versionList").innerHTML = `<li class="error-text">${escapeHTML(err.message)}</li>`;
  }
});
$("#closeVersions").addEventListener("click", () => closeDialog(versionsModal));
$("#versionList").addEventListener("click", async (e) => {
  const view = e.target.closest("[data-view]");
  const restore = e.target.closest("[data-restore]");
  const compare = e.target.closest("[data-compare]");
  if (!view && !restore && !compare) return;
  const btn = view || restore || compare;
  try {
    const v = await lib.version(cur.id, btn.dataset.view || btn.dataset.restore || btn.dataset.compare);
    if (!v) return toast(t("notFound"), true);
    $$("#versionList li").forEach((li) => li.classList.toggle("selected", li.contains(btn)));
    const p = $("#versionPreview");
    if (compare) {
      const parts = diffWords(htmlToText(sanitize(v.html)), htmlToText(doc.innerHTML));
      const { added, removed } = diffStats(parts);
      p.innerHTML = `<div class="diff">${renderDiff(parts)}</div>`;
      $("#diffSummary").textContent = added || removed ? t("diffSummary", { a: added, r: removed }) : t("diffSame");
      $("#diffLegend").classList.remove("hidden");
      p.classList.remove("hidden");
      p.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (view) {
      $("#diffLegend").classList.add("hidden");
      p.innerHTML = sanitize(v.html);
      p.classList.remove("hidden");
      p.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (confirm(t("restoreConfirm"))) {
      setDocHTML(v.html, cur.lang);
      closeDialog(versionsModal);
      await save({ version: t("vRestored", { date: timeStr(v.at) }), silent: true });
      toast(t("restored"));
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ───────────────────────── exportar, copiar, guardar, nuevo ─────────────────────────
const brand = () => (profile.brandExports !== false && (profile.name || profile.logo) ? profile : null);

async function downloadPDF() {
  if (!requireDoc()) return;
  toast(t("pdfPreparing"));
  try {
    if (await integrityWarning()) react("preocupada", t("lc_integrity"));
    await exportPDF(doc, { brand: brand(), certificate: await certificateFor() });
  } catch (err) {
    toast(t("pdfFailed") + " " + err.message, true);
  }
}
$("#pdfBtn").addEventListener("click", downloadPDF);
$("#wordBtn").addEventListener("click", async () => {
  if (!requireDoc()) return;
  toast(t("wordPreparing"));
  try { await exportDocx(doc, { brand: brand(), certificate: await certificateFor() }); } catch (err) { console.error(err); toast(t("wordFailed"), true); }
});
$("#copyBtn").addEventListener("click", () => requireDoc() && copyText(doc.innerText));
$("#saveBtn").addEventListener("click", () => save({ version: t("vManual") }));
$("#newBtn").addEventListener("click", async () => {
  if (!docIsEmpty() && !confirm(t("newConfirm"))) return;
  if (!docIsEmpty()) await save({ silent: true });
  resetDoc();
  $("#crear").scrollIntoView({ behavior: "smooth" });
});

const autosave = debounce(() => save({ silent: true }), 1500);
doc.addEventListener("input", () => {
  if (docIsEmpty()) return;
  lastEditAt = Date.now();
  dirty = true;
  setStatus(t("unsaved"));
  autosave();
});

// ───────────────────────── panel ─────────────────────────
const goPanel = () => $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
$("#openHistory").addEventListener("click", goPanel);
$("#menuHistory").addEventListener("click", goPanel);

// ───────────────────────── idioma de la interfaz ─────────────────────────
$("#langBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#langMenu").classList.toggle("hidden");
});
$("#langMenu").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => $("#langMenu").classList.add("hidden"));

async function changeUILang(target) {
  const ok = await setUILang(target, {
    onStart: () => { $("#langBtn").classList.add("spinning"); toast(t("uiTranslating")); },
    onEnd: () => $("#langBtn").classList.remove("spinning"),
  });
  if (!ok) toast(t("uiTranslateFailed"), true);
  $("#uiLang").value = getUILang();
  $("#outLang").value = getUILang();
  $("#langMenu").classList.add("hidden");
}
$("#uiLang").addEventListener("change", () => {
  const v = readLang($("#uiLang"), getUILang());
  if (v) changeUILang(v);
});

onLangChange(() => {
  renderTypes();
  renderDashboard();
  renderTemplates();
  renderDueBanner();
  if (docIsEmpty()) renderEmptyDoc();
  fillLangSelect($("#outLang"), { value: $("#outLang").value });
  fillLangSelect($("#transLang"), { value: $("#transLang").value });
  fillLangSelect($("#uiLang"), { value: getUILang() });
});

// ───────────────────────── cuentas ─────────────────────────
async function offerImport() {
  const local = localLib.all();
  if (!local.length || !confirm(t("importAsk", { n: local.length }))) return;
  let ok = 0;
  for (const c of local) {
    try {
      await cloudLib.save(c, { version: t("vImported") });
      ok++;
    } catch (err) {
      console.error(err);
    }
  }
  if (ok === local.length) localLib.clear();
  toast(t("imported", { n: ok }));
}

onUser(async (user) => {
  lib = user ? cloudLib : localLib;
  resetDoc();
  if (user) await offerImport();
  await refreshList();
  renderTemplates();
  loadProfile();
});

// ───────────────────────── inicio ─────────────────────────
async function init() {
  const uiPref = initI18n();
  initSettings(app);
  initDashboard(app);
  Object.assign(app, initTemplates(app));
  Object.assign(app, initCollab(app));
  attachDictation($("#promptMic"), $("#prompt"));
  attachDictation($("#laceyMic"), $("#laceyInput"));
  loadProfile();
  fillLangSelect($("#outLang"));
  fillLangSelect($("#transLang"), { value: "English" });
  fillLangSelect($("#uiLang"), { value: "Spanish" });
  renderTypes();
  renderEmptyDoc();
  $("#year").textContent = new Date().getFullYear();
  await refreshList();
  if (uiPref && uiPref !== "Spanish") changeUILang(uiPref);
  await initAuth();
  if (!authAvailable()) $("#loginBtn").title = t("authOff");
  initLacey({ getContext: laceyContext, actions: laceyActions });
  greetDue();
}

// ───────────────────────── Lacey ─────────────────────────
function aiFailed(err) {
  setMood("preocupada");
  if (err.data?.limit) {
    react("preocupada", err.message, { actions: currentUser() ? [] : ["login"] });
  } else {
    toast(err.message, true);
  }
}

// ───────────────────────── perfil (mi marca) ─────────────────────────
const profiles = () => (currentUser() ? cloudProfile : localProfile);
function setProfile(p) {
  profile = p || {};
  $("#partyAWrap").classList.toggle("hidden", !profile.name);
  $("#usePartyA").checked = !!profile.useAsPartyA;
}
async function loadProfile() {
  try { setProfile(await profiles().get()); } catch { setProfile({}); }
}

// ───────────────────────── contexto compartido con los módulos ─────────────────────────
const app = {
  get cur() { return cur; },
  get list() { return list; },
  get lib() { return lib; },
  get profile() { return profile; },
  get dirty() { return dirty; },
  get loggedIn() { return !!currentUser(); },
  doc,
  docIsEmpty, requireDoc, save, openContract, loadContract, refreshList, resetDoc, createContract, openFromList,
  dueText: (d) => dueText(d),
  openAuth: (reason) => openAuth(reason),
  exportPDF: () => downloadPDF(),
  templates: () => (currentUser() ? cloudTemplates : localTemplates),
  profiles,
  setProfile,
};

function laceyContext() {
  const meta = list.find((x) => x.id === cur?.id);
  return {
    contract: docIsEmpty() ? "" : doc.innerText.slice(0, 30000),
    page: {
      loggedIn: !!currentUser(),
      title: docIsEmpty() ? "" : cur?.title || "",
      endDate: cur?.endDate || "",
      pendingSignatures: (meta?.shares || []).filter((s) => s.status === "pending").length,
    },
  };
}

const goTo = (sel, focus) => {
  $(sel).scrollIntoView({ behavior: "smooth", block: "start" });
  if (focus) setTimeout(() => $(focus)?.focus({ preventScroll: true }), 500);
};
const laceyActions = {
  generate: () => goTo("#crear", activeTab === "describe" ? "#prompt" : "#fA"),
  review: () => $("#reviewBtn").click(),
  share: () => $("#shareBtn").click(),
  sign: () => $("#signBtn").click(),
  due: () => $("#dueBtn").click(),
  versions: () => $("#versionsBtn").click(),
  translate: () => goTo(".editor-card", "#transLang"),
  pdf: () => $("#pdfBtn").click(),
  word: () => $("#wordBtn").click(),
  analyze: () => goTo("#analizar"),
  login: () => (currentUser() ? $("#avatarBtn").click() : openAuth()),
  tour: () => startTour(),
  dashboard: () => goPanel(),
  templates: () => showTemplatesTab(),
  comments: () => $("#commentsBtn").click(),
  certificate: () => $("#certBtn").click(),
  settings: () => openSettings(),
};

/** Al entrar, si hay un contrato por vencer, Lacey avisa (una vez por sesión). */
function greetDue() {
  let seen = false;
  try { seen = sessionStorage.getItem("laceyLegal.dueGreeted") === "1"; } catch { /* sin acceso */ }
  if (seen || !store.get("laceyLegal.laceySeen")) return; // en la primera visita manda el saludo
  const due = list
    .map((c) => ({ c, d: daysLeft(c.endDate) }))
    .filter(({ c, d }) => d !== null && d >= 0 && d <= (c.remindDays ?? 7))
    .sort((a, b) => a.d - b.d)[0];
  if (!due) return;
  try { sessionStorage.setItem("laceyLegal.dueGreeted", "1"); } catch { /* sin acceso */ }
  setTimeout(() => react("preocupada", t("lc_dueSoon", { title: due.c.title, when: dueText(due.d) }), {
    actions: [{ label: t("lc_open"), run: () => loadContract(due.c.id) }],
  }), 1800);
}
init();
