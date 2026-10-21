// Plantillas: guardar el contrato actual como plantilla y crear contratos desde una.
import { $, escapeHTML, toast, sanitize, cleanAIHtml, ai, uid, openDialog, closeDialog } from "./util.js";
import { t, getUILang } from "./i18n.js";
import { templateFields } from "./storage.js";
import { renderTemplates } from "./dashboard.js";

let app;
let draftHTML = "";
let editingId = null;
let chosen = null;

const SIGNATURES_RE = /(?:<h2>[^<]*<\/h2>\s*)?<div class="signatures">(?:\s*<div class="sig-block">[\s\S]*?<\/div>\s*)*<\/div>/g;
const highlight = (html) => html.replace(/\{([^{}<>]{1,40})\}/g, '<mark class="tpl-field">{$1}</mark>');

function refreshDraft() {
  const fields = templateFields(draftHTML);
  $("#tplFields").innerHTML = fields.length
    ? fields.map((f) => `<span class="pill field">${escapeHTML(f)}</span>`).join("")
    : `<span class="small muted">${escapeHTML(t("tplNoFields"))}</span>`;
  $("#tplPreview").innerHTML = highlight(sanitize(draftHTML));
}

function openSave() {
  if (!app.requireDoc()) return;
  draftHTML = app.doc.innerHTML.replace(SIGNATURES_RE, "");
  editingId = null;
  $("#tplName").value = (app.doc.querySelector("h1")?.textContent || t("untitled")).trim().slice(0, 100);
  refreshDraft();
  openDialog($("#tplSaveModal"));
}

async function detectWithAI() {
  const btn = $("#tplAI");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = t("tplDetecting");
  try {
    draftHTML = sanitize(cleanAIHtml(await ai({ action: "templatize", html: draftHTML, language: getUILang() })));
    refreshDraft();
    toast(t("tplDetected", { n: templateFields(draftHTML).length }));
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveTemplate() {
  const name = $("#tplName").value.trim();
  if (!name) return toast(t("tplNeedName"), true);
  try {
    await app.templates().save(editingId || uid(), { name, html: draftHTML });
    closeDialog($("#tplSaveModal"));
    toast(t("tplSaved"));
    renderTemplates();
  } catch (err) {
    toast(err.message === "storage-full" ? t("storageFull") : err.message, true);
  }
}

// ───────────────────────── usar ─────────────────────────
async function showPicker() {
  chosen = null;
  $("#tplUseTitle").textContent = t("tplUseTitle");
  $("#tplPick").classList.remove("hidden");
  $("#tplFill").classList.add("hidden");
  $("#tplPickList").innerHTML = `<li class="muted">${escapeHTML(t("loading"))}</li>`;
  openDialog($("#tplUseModal"));
  try {
    const list = await app.templates().list();
    $("#tplPickList").innerHTML = list.length
      ? list.map((x) => `<li><button type="button" class="tpl-option" data-pick="${escapeHTML(x.id)}">
          <strong>${escapeHTML(x.name)}</strong><small>${escapeHTML(t("nFields", { n: x.fields.length }))}</small></button></li>`).join("")
      : `<li class="dash-empty small-empty"><p><strong>${escapeHTML(t("tplEmptyTitle"))}</strong></p><p class="muted">${escapeHTML(t("tplEmptyText"))}</p></li>`;
  } catch (err) {
    $("#tplPickList").innerHTML = `<li class="error-text">${escapeHTML(err.message)}</li>`;
  }
}

const humanize = (f) => f.charAt(0).toUpperCase() + f.slice(1);

async function showFill(id) {
  try {
    chosen = await app.templates().get(id);
    if (!chosen) return toast(t("notFound"), true);
  } catch (err) {
    return toast(err.message, true);
  }
  if (!$("#tplUseModal").open) openDialog($("#tplUseModal"));
  $("#tplUseTitle").textContent = chosen.name;
  $("#tplPick").classList.add("hidden");
  $("#tplFill").classList.remove("hidden");
  const fields = templateFields(chosen.html);
  $("#tplFillFields").innerHTML = fields.length
    ? fields.map((f, i) => `<label class="field${fields.length === 1 ? " full" : ""}"><span>${escapeHTML(humanize(f))}</span>
        <input data-field="${escapeHTML(f)}" maxlength="300" ${i === 0 ? "autofocus" : ""} /></label>`).join("")
    : `<p class="muted full">${escapeHTML(t("tplNoFieldsUse"))}</p>`;
  setTimeout(() => $("#tplFillFields input")?.focus(), 60);
}

async function createFromTemplate() {
  const values = {};
  document.querySelectorAll("#tplFillFields [data-field]").forEach((i) => { values[i.dataset.field] = i.value.trim(); });
  const html = chosen.html.replace(/\{([^{}<>]{1,40})\}/g, (m, f) => {
    const v = values[f.trim()];
    return v ? escapeHTML(v) : "[__________]";
  });
  closeDialog($("#tplUseModal"));
  await app.createContract({ html, lang: getUILang(), version: t("vFromTemplate", { name: chosen.name }), open: true });
  toast(t("tplCreated"));
}

export function initTemplates(ctx) {
  app = ctx;
  $("#tplSaveBtn").addEventListener("click", openSave);
  $("#tplAI").addEventListener("click", detectWithAI);
  $("#tplSave").addEventListener("click", saveTemplate);
  $("#closeTplSave").addEventListener("click", () => closeDialog($("#tplSaveModal")));
  $("#closeTplUse").addEventListener("click", () => closeDialog($("#tplUseModal")));
  $("#tplPickList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b) showFill(b.dataset.pick);
  });
  $("#tplBack").addEventListener("click", showPicker);
  $("#tplCreate").addEventListener("click", createFromTemplate);
  $("#tplFillFields").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createFromTemplate(); }
  });
  $("#fromTemplate").addEventListener("click", showPicker);
  return { useTemplate: (id) => (id ? showFill(id) : showPicker()), openSave };
}
