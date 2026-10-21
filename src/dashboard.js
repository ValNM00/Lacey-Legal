// Panel "Mis contratos": estadísticas, estados, búsqueda, carpetas y orden.
import { $, $$, escapeHTML, toast, daysLeft, store, openDialog, closeDialog } from "./util.js";
import { t, getUILang, langCode } from "./i18n.js";

const ICON = (body) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const I_TRASH = ICON('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/>');
const I_FOLDER = ICON('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>');
const I_COPY = ICON('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>');

const PREF = "laceyLegal.dash.v1";
let app;
let filter = "all";
let tab = "contracts";
const prefs = store.get(PREF, { sort: "updated", folder: "" });
let folderTarget = null;

// ───────────────────────── estado de cada contrato ─────────────────────────
export function statusOf(x) {
  const shares = x.shares || [];
  const pending = shares.filter((s) => s.status === "pending").length;
  const d = daysLeft(x.endDate);
  if (d !== null && d < 0) return "expired";
  if (pending) return "waiting";
  if ((x.sigCount || 0) > 0) return "signed";
  return "draft";
}

const dueSoon = (x) => {
  const d = daysLeft(x.endDate);
  return d !== null && d >= 0 && d <= (x.remindDays ?? 7);
};

export function relTime(ts) {
  const diff = (ts - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(langCode(getUILang()), { numeric: "auto" });
  const steps = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"], [Infinity, "year"]];
  const div = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
  for (const [limit, unit] of steps) {
    if (Math.abs(diff) < limit) return rtf.format(Math.round(diff / div[unit]), unit);
  }
  return "";
}

// ───────────────────────── render ─────────────────────────
function renderStats(list) {
  const counts = {
    all: list.length,
    draft: list.filter((x) => statusOf(x) === "draft").length,
    waiting: list.filter((x) => statusOf(x) === "waiting").length,
    signed: list.filter((x) => statusOf(x) === "signed").length,
    due: list.filter((x) => dueSoon(x) || statusOf(x) === "expired").length,
  };
  $("#dashStats").innerHTML = ["all", "draft", "waiting", "signed", "due"].map((k) => `
    <button type="button" class="stat stat-${k}${filter === k ? " active" : ""}" data-filter="${k}" aria-pressed="${filter === k}">
      <span class="stat-num">${counts[k]}</span><span class="stat-label">${escapeHTML(t("st_" + k))}</span>
    </button>`).join("");
}

function renderFolders(list) {
  const folders = [...new Set(list.map((x) => x.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (prefs.folder && !folders.includes(prefs.folder)) prefs.folder = "";
  $("#dashFolder").innerHTML =
    `<option value="">${escapeHTML(t("allFolders"))}</option>` +
    folders.map((f) => `<option value="${escapeHTML(f)}"${f === prefs.folder ? " selected" : ""}>${escapeHTML(f)}</option>`).join("");
  $("#dashFolder").classList.toggle("hidden", !folders.length);
  $("#folderList").innerHTML = folders.map((f) => `<option value="${escapeHTML(f)}"></option>`).join("");
}

function filtered(list) {
  const q = $("#dashSearch").value.trim().toLowerCase();
  let out = list.filter((x) => {
    if (prefs.folder && x.folder !== prefs.folder) return false;
    if (q && !`${x.title} ${x.folder}`.toLowerCase().includes(q)) return false;
    if (filter === "all") return true;
    if (filter === "due") return dueSoon(x) || statusOf(x) === "expired";
    return statusOf(x) === filter;
  });
  const sort = prefs.sort;
  out = [...out].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "due") {
      const da = daysLeft(a.endDate);
      const db = daysLeft(b.endDate);
      return (da ?? 1e9) - (db ?? 1e9);
    }
    return b.updated - a.updated;
  });
  return out;
}

function card(x) {
  const st = statusOf(x);
  const shares = x.shares || [];
  const signedLinks = shares.filter((s) => s.status === "signed").length;
  const totalSigners = shares.length;
  const d = daysLeft(x.endDate);
  const flags = [
    dueSoon(x) ? `<span class="pill wait">${escapeHTML(app.dueText(d))}</span>` : "",
    st === "expired" ? `<span class="pill late">${escapeHTML(app.dueText(d))}</span>` : "",
    x.openComments ? `<span class="pill note">${escapeHTML(t("nComments", { n: x.openComments }))}</span>` : "",
  ].join("");
  const progress = totalSigners
    ? `<div class="c-progress" title="${escapeHTML(t("signedOf", { a: signedLinks, b: totalSigners }))}">
        <div class="bar"><span style="width:${Math.round((signedLinks / totalSigners) * 100)}%"></span></div>
        <small>${escapeHTML(t("signedOf", { a: signedLinks, b: totalSigners }))}</small></div>`
    : x.sigCount ? `<div class="c-progress"><small>${escapeHTML(t("nSignatures", { n: x.sigCount }))}</small></div>` : "";
  return `<article class="c-card${x.id === app.cur?.id ? " current" : ""}" data-id="${escapeHTML(x.id)}">
    <div class="c-top">
      <span class="status s-${st}">${escapeHTML(t("one_" + st))}</span>
      ${x.folder ? `<span class="c-folder">${I_FOLDER}${escapeHTML(x.folder)}</span>` : ""}
    </div>
    <h3><button type="button" class="c-open" data-open="${escapeHTML(x.id)}">${escapeHTML(x.title)}</button></h3>
    <p class="c-meta">${escapeHTML(t("editedAgo", { when: relTime(x.updated) }))}</p>
    ${progress}
    ${flags ? `<div class="pills">${flags}</div>` : ""}
    <div class="c-actions">
      <button type="button" class="btn btn-soft btn-sm" data-open="${escapeHTML(x.id)}">${escapeHTML(t("open"))}</button>
      <span class="spacer"></span>
      <button type="button" class="icon-btn icon-sm" data-folder="${escapeHTML(x.id)}" aria-label="${escapeHTML(t("moveFolder"))}" title="${escapeHTML(t("moveFolder"))}">${I_FOLDER}</button>
      <button type="button" class="icon-btn icon-sm" data-dup="${escapeHTML(x.id)}" aria-label="${escapeHTML(t("duplicate"))}" title="${escapeHTML(t("duplicate"))}">${I_COPY}</button>
      <button type="button" class="icon-btn icon-sm" data-del="${escapeHTML(x.id)}" aria-label="${escapeHTML(t("delete"))}" title="${escapeHTML(t("delete"))}">${I_TRASH}</button>
    </div>
  </article>`;
}

function emptyState(kind) {
  const texts = {
    none: [t("dashEmptyTitle"), t("dashEmptyText")],
    filter: [t("dashNoMatchTitle"), t("dashNoMatchText")],
    tpl: [t("tplEmptyTitle"), t("tplEmptyText")],
  }[kind];
  return `<div class="dash-empty">
    <img src="/lacey/${kind === "filter" ? "pensando" : "normal"}.webp" alt="" width="140" height="140" loading="lazy" />
    <div><h3>${escapeHTML(texts[0])}</h3><p>${escapeHTML(texts[1])}</p>
    ${kind === "none" ? `<a class="btn btn-primary btn-sm" href="#crear">${escapeHTML(t("dashNew"))}</a>` : ""}</div></div>`;
}

export function renderDashboard() {
  if (!app) return;
  const list = app.list;
  $("#dashMode").textContent = app.lib.kind === "cloud" ? t("historyCloud") : t("historyLocal");
  $("#historyCount").textContent = list.length;
  renderStats(list);
  renderFolders(list);
  $("#dashSort").value = prefs.sort;
  const items = filtered(list);
  $("#contractGrid").innerHTML = !list.length ? emptyState("none") : items.length ? items.map(card).join("") : emptyState("filter");
}

export async function renderTemplates() {
  let tpls = [];
  try { tpls = await app.templates().list(); } catch (err) { console.error(err); }
  $("#tplCount").textContent = tpls.length;
  $("#tplGrid").innerHTML = tpls.length
    ? tpls.map((x) => `<article class="c-card tpl-card" data-tpl="${escapeHTML(x.id)}">
        <div class="c-top"><span class="status s-tpl">${escapeHTML(t("template"))}</span></div>
        <h3>${escapeHTML(x.name)}</h3>
        <p class="c-meta">${escapeHTML(t("nFields", { n: x.fields.length }))} · ${escapeHTML(relTime(x.updated))}</p>
        <div class="pills">${x.fields.slice(0, 5).map((f) => `<span class="pill field">${escapeHTML(f)}</span>`).join("")}${x.fields.length > 5 ? `<span class="pill">+${x.fields.length - 5}</span>` : ""}</div>
        <div class="c-actions">
          <button type="button" class="btn btn-soft btn-sm" data-use="${escapeHTML(x.id)}">${escapeHTML(t("useTemplate"))}</button>
          <span class="spacer"></span>
          <button type="button" class="icon-btn icon-sm" data-tpldel="${escapeHTML(x.id)}" aria-label="${escapeHTML(t("delete"))}" title="${escapeHTML(t("delete"))}">${I_TRASH}</button>
        </div></article>`).join("")
    : emptyState("tpl");
}

function setTab(next) {
  tab = next;
  $$(".dash-tabs .tab").forEach((b) => {
    const on = b.dataset.dtab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("#contractGrid").classList.toggle("hidden", tab !== "contracts");
  $("#dashStats").classList.toggle("hidden", tab !== "contracts");
  $("#dashTools").classList.toggle("hidden", tab !== "contracts");
  $("#tplGrid").classList.toggle("hidden", tab !== "templates");
  if (tab === "templates") renderTemplates();
}
export const showTemplatesTab = () => {
  setTab("templates");
  $("#panel").scrollIntoView({ behavior: "smooth" });
};

// ───────────────────────── acciones ─────────────────────────
async function duplicate(id) {
  try {
    const c = await app.lib.get(id);
    if (!c) return toast(t("notFound"), true);
    const title = t("copyOf", { title: c.title });
    const html = c.html.replace(/<h1>[\s\S]*?<\/h1>/, `<h1>${escapeHTML(title)}</h1>`);
    await app.createContract({ html, lang: c.lang, version: t("vDuplicated"), folder: c.folder, open: false });
    toast(t("duplicated"));
  } catch (err) {
    toast(err.message, true);
  }
}

export function initDashboard(ctx) {
  app = ctx;
  $("#dashStats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    filter = filter === b.dataset.filter && filter !== "all" ? "all" : b.dataset.filter;
    renderDashboard();
  });
  $("#dashSearch").addEventListener("input", renderDashboard);
  $("#dashFolder").addEventListener("change", (e) => { prefs.folder = e.target.value; store.set(PREF, prefs); renderDashboard(); });
  $("#dashSort").addEventListener("change", (e) => { prefs.sort = e.target.value; store.set(PREF, prefs); renderDashboard(); });
  $$(".dash-tabs .tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.dtab)));

  $("#contractGrid").addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    const del = e.target.closest("[data-del]");
    const dup = e.target.closest("[data-dup]");
    const fol = e.target.closest("[data-folder]");
    if (open) return app.openFromList(open.dataset.open);
    if (dup) return duplicate(dup.dataset.dup);
    if (fol) {
      folderTarget = fol.dataset.folder;
      $("#folderInput").value = app.list.find((x) => x.id === folderTarget)?.folder || "";
      openDialog($("#folderModal"));
      setTimeout(() => $("#folderInput").focus(), 50);
      return;
    }
    if (del) {
      if (!confirm(t("deleteConfirm"))) return;
      try {
        await app.lib.remove(del.dataset.del);
        if (app.cur?.id === del.dataset.del) app.resetDoc();
        await app.refreshList();
        toast(t("deleted"));
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  const moveTo = async (folder) => {
    closeDialog($("#folderModal"));
    try {
      await app.lib.setFolder(folderTarget, folder.trim().slice(0, 60));
      await app.refreshList();
      toast(folder ? t("movedTo", { folder }) : t("movedNone"));
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#folderSave").addEventListener("click", () => moveTo($("#folderInput").value));
  $("#folderInput").addEventListener("keydown", (e) => { if (e.key === "Enter") moveTo($("#folderInput").value); });
  $("#folderNone").addEventListener("click", () => moveTo(""));
  $("#closeFolder").addEventListener("click", () => closeDialog($("#folderModal")));

  $("#tplGrid").addEventListener("click", async (e) => {
    const use = e.target.closest("[data-use]");
    const del = e.target.closest("[data-tpldel]");
    if (use) return app.useTemplate(use.dataset.use);
    if (del && confirm(t("tplDeleteConfirm"))) {
      try {
        await app.templates().remove(del.dataset.tpldel);
        renderTemplates();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });
  $("#dashTpl").addEventListener("click", () => app.useTemplate());
  renderTemplates();
}
