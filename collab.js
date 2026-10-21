// Colaboración: enviar a firmar (varias personas, en orden), estado y recordatorios,
// comentarios de quienes firman y certificado de firmas.
import { $, $$, escapeHTML, toast, api, openDialog, closeDialog } from "./util.js";
import { t, getUILang, langCode } from "./i18n.js";
import { certificateHTML, integrity } from "./certificate.js";
import { react } from "./assistant.js";

let app;
const signLink = (token) => `${location.origin}/firmar.html#${token}`;
const fmt = (ts) => new Date(ts).toLocaleString(langCode(getUILang()), { dateStyle: "medium", timeStyle: "short" });
const ICON_X = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// ───────────────────────── enviar a firmar ─────────────────────────
function signerRow(i, data = {}) {
  const row = document.createElement("div");
  row.className = "signer-row";
  row.innerHTML = `
    <span class="signer-num" aria-hidden="true">${i + 1}</span>
    <input data-k="name" maxlength="80" placeholder="${escapeHTML(t("phName"))}" aria-label="${escapeHTML(t("phName"))}" value="${escapeHTML(data.name || "")}" />
    <input data-k="role" maxlength="80" placeholder="${escapeHTML(t("phRole"))}" aria-label="${escapeHTML(t("phRole"))}" value="${escapeHTML(data.role || "")}" />
    <input data-k="email" type="email" maxlength="254" placeholder="${escapeHTML(t("phEmail"))}" aria-label="${escapeHTML(t("phEmail"))}" value="${escapeHTML(data.email || "")}" />
    <button type="button" class="icon-btn icon-sm" data-remove aria-label="${escapeHTML(t("remove"))}">${ICON_X}</button>`;
  return row;
}

function renumber() {
  $$("#signerRows .signer-row").forEach((r, i) => { r.querySelector(".signer-num").textContent = i + 1; });
  const many = $$("#signerRows .signer-row").length > 1;
  $$("#signerRows [data-remove]").forEach((b) => b.classList.toggle("hidden", !many));
  $("#shareOrdered").closest("label").classList.toggle("hidden", !many);
  $("#addSigner").classList.toggle("hidden", $$("#signerRows .signer-row").length >= 8);
}

function shareStatus(s, shares) {
  if (s.status === "signed") return ["ok", t("shSigned", { date: fmt(s.signedAt) })];
  if (Date.now() - s.created > 30 * 864e5) return ["late", t("shExpired")];
  if (s.ordered && shares.some((o) => o.group === s.group && o.order < s.order && o.status === "pending")) return ["", t("shWaitingTurn")];
  if (s.viewedAt) return ["wait", t("shViewed", { date: fmt(s.viewedAt) })];
  return ["wait", t("shPending")];
}

export function renderShares() {
  const meta = app.list.find((x) => x.id === app.cur?.id);
  const shares = [...(meta?.shares || [])].sort((a, b) => a.created - b.created || a.order - b.order);
  $("#shareList").innerHTML = shares.length
    ? shares.map((s) => {
        const [cls, label] = shareStatus(s, shares);
        return `<li class="share-item">
          ${s.ordered ? `<span class="signer-num small">${s.order + 1}</span>` : ""}
          <div class="share-who"><strong>${escapeHTML(s.signedName || s.signerName)}</strong>
            <small>${escapeHTML([s.role, s.email].filter(Boolean).join(" · "))}</small></div>
          <span class="pill ${cls}">${escapeHTML(label)}</span>
          ${s.status === "pending" ? `<div class="share-actions">
            <button type="button" class="tool" data-copy="${s.token}">${escapeHTML(t("copyLink"))}</button>
            <button type="button" class="tool" data-remind="${s.token}">${escapeHTML(t("remind"))}</button>
            <button type="button" class="tool" data-revoke="${s.token}">${escapeHTML(t("revoke"))}</button></div>` : ""}
        </li>`;
      }).join("")
    : `<li class="muted">${escapeHTML(t("noShares"))}</li>`;
}

async function openShare() {
  if (!app.requireDoc()) return;
  if (!app.loggedIn) return app.openAuth(t("needLoginShare"));
  await app.save({ silent: true });
  $("#signerRows").innerHTML = "";
  $("#signerRows").append(signerRow(0));
  $("#shareOrdered").checked = false;
  $("#shareResult").classList.add("hidden");
  renumber();
  renderShares();
  openDialog($("#shareModal"));
  setTimeout(() => {
    if (!document.activeElement?.matches("#shareModal input, #shareModal textarea")) $("#signerRows input")?.focus();
  }, 60);
}

async function createLinks() {
  const signers = $$("#signerRows .signer-row").map((r) => ({
    name: r.querySelector('[data-k="name"]').value.trim(),
    role: r.querySelector('[data-k="role"]').value.trim(),
    email: r.querySelector('[data-k="email"]').value.trim(),
  })).filter((s) => s.name || s.email || s.role);
  if (!signers.length || signers.some((s) => !s.name)) return toast(t("needSignerName"), true);
  const btn = $("#createShare");
  btn.disabled = true;
  try {
    const r = await api("/api/share", { method: "POST", body: { cid: app.cur.id, ordered: $("#shareOrdered").checked, signers } });
    $("#shareResult").innerHTML = r.links.map((l) => {
      const link = signLink(l.token);
      const msg = t("shareMsg", { name: l.name, title: app.cur.title, link });
      return `<li class="share-new-item">
        <div class="share-who"><strong>${escapeHTML(l.name)}</strong>
          <small>${escapeHTML(l.email ? (r.emailed && (!r.ordered || l.order === 0) ? t("shEmailed", { email: l.email }) : l.email) : t("shSendYourself"))}</small></div>
        <div class="share-actions">
          <button type="button" class="btn btn-soft btn-sm" data-copy="${l.token}">${escapeHTML(t("copyLink"))}</button>
          <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">WhatsApp</a>
          <a class="btn btn-ghost btn-sm" href="mailto:${encodeURIComponent(l.email || "")}?subject=${encodeURIComponent(t("shareSubject", { title: app.cur.title }))}&body=${encodeURIComponent(msg)}">${escapeHTML(t("emailWord"))}</a>
        </div></li>`;
    }).join("");
    $("#shareResult").classList.remove("hidden");
    $("#signerRows").innerHTML = "";
    $("#signerRows").append(signerRow(0));
    renumber();
    await app.refreshList();
    renderShares();
    react("feliz", r.ordered ? t("lc_sentOrdered", { n: r.links.length }) : t("lc_sent", { n: r.links.length }));
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("copied"));
  } catch {
    toast(t("copyFailed"), true);
  }
}

async function shareListClick(e) {
  const c = e.target.closest("[data-copy]");
  if (c) return copy(signLink(c.dataset.copy));
  const rm = e.target.closest("[data-remind]");
  if (rm) {
    rm.disabled = true;
    try {
      const r = await api(`/api/share/${rm.dataset.remind}/remind`, { method: "POST" });
      if (r.emailed) toast(t("remindedEmail"));
      else { await copy(r.link); toast(t("remindedCopy")); }
      await app.refreshList();
      renderShares();
    } catch (err) {
      toast(err.message, true);
    } finally {
      rm.disabled = false;
    }
    return;
  }
  const rv = e.target.closest("[data-revoke]");
  if (rv && confirm(t("revokeConfirm"))) {
    try {
      await api(`/api/share/${rv.dataset.revoke}`, { method: "DELETE" });
      await app.refreshList();
      renderShares();
    } catch (err) {
      toast(err.message, true);
    }
  }
}

// ───────────────────────── comentarios ─────────────────────────
export function updateCommentsBadge() {
  const open = (app.cur?.comments || []).filter((c) => c.status === "open").length;
  $("#commentsCount").textContent = open;
  $("#commentsCount").classList.toggle("hidden", !open);
}

function renderComments() {
  const list = [...(app.cur?.comments || [])].sort((a, b) => (a.status === b.status ? b.at - a.at : a.status === "open" ? -1 : 1));
  $("#commentList").innerHTML = list.length
    ? list.map((c) => `<li class="comment ${c.status}" data-cid="${escapeHTML(c.id)}">
        <div class="comment-head"><strong>${escapeHTML(c.name)}</strong><small>${escapeHTML(fmt(c.at))}</small>
          <span class="pill ${c.status === "open" ? "wait" : "ok"}">${escapeHTML(t(c.status === "open" ? "cmOpen" : "cmResolved"))}</span></div>
        ${c.quote ? `<blockquote>${escapeHTML(c.quote)}</blockquote>` : ""}
        <p>${escapeHTML(c.text)}</p>
        ${c.reply ? `<div class="comment-reply"><small>${escapeHTML(t("cmYourReply"))}</small><p>${escapeHTML(c.reply)}</p></div>` : ""}
        <div class="comment-actions">
          <textarea class="reply-input hidden" rows="2" maxlength="1500" placeholder="${escapeHTML(t("cmReplyPh"))}"></textarea>
          <button type="button" class="tool" data-reply>${escapeHTML(t(c.reply ? "cmEditReply" : "cmReply"))}</button>
          <button type="button" class="tool" data-toggle>${escapeHTML(t(c.status === "open" ? "cmResolve" : "cmReopen"))}</button>
          ${c.quote ? `<button type="button" class="tool" data-find>${escapeHTML(t("cmFind"))}</button>` : ""}
        </div></li>`).join("")
    : `<li class="muted">${escapeHTML(t(app.loggedIn ? "cmNone" : "cmNeedLogin"))}</li>`;
}

async function patchComment(id, patch) {
  const r = await app.lib.comment(app.cur.id, id, patch);
  const i = app.cur.comments.findIndex((c) => c.id === id);
  if (i >= 0) app.cur.comments[i] = r.comment;
  updateCommentsBadge();
  renderComments();
  await app.refreshList();
}

/** Resalta en el contrato el texto que citó la persona. */
function findQuote(quote) {
  closeDialog($("#commentsModal"));
  const walker = document.createTreeWalker(app.doc, NodeFilter.SHOW_TEXT);
  const needle = quote.slice(0, 60).toLowerCase();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.nodeValue.toLowerCase().indexOf(needle);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, Math.min(n.nodeValue.length, i + quote.length));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    n.parentElement.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  toast(t("cmNotFound"), true);
}

async function commentClick(e) {
  const li = e.target.closest("[data-cid]");
  if (!li) return;
  const c = app.cur.comments.find((x) => x.id === li.dataset.cid);
  const input = li.querySelector(".reply-input");
  try {
    if (e.target.closest("[data-reply]")) {
      if (input.classList.contains("hidden")) {
        input.classList.remove("hidden");
        input.value = c.reply || "";
        input.focus();
        e.target.textContent = t("cmSend");
      } else if (input.value.trim()) {
        await patchComment(c.id, { reply: input.value.trim() });
        toast(t("cmReplied"));
      }
    } else if (e.target.closest("[data-toggle]")) {
      await patchComment(c.id, { status: c.status === "open" ? "resolved" : "open" });
    } else if (e.target.closest("[data-find]")) {
      findQuote(c.quote);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ───────────────────────── certificado ─────────────────────────
async function openCertificate() {
  if (!app.requireDoc()) return;
  if (app.dirty) await app.save({ silent: true });
  $("#certBody").innerHTML = await certificateHTML({ title: app.cur?.title || "", html: app.doc.innerHTML, audit: app.cur?.audit || [], docEl: app.doc });
  openDialog($("#certModal"));
}

/** HTML del certificado si el contrato tiene firmas (para el PDF/Word). */
export async function certificateFor() {
  const audit = app.cur?.audit || [];
  const hasSigs = audit.some((e) => e.type === "signed" || e.type === "signed-here") || app.doc.querySelector(".sig-block");
  if (!hasSigs) return null;
  return certificateHTML({ title: app.cur?.title || "", html: app.doc.innerHTML, audit, docEl: app.doc });
}

export async function integrityWarning() {
  const r = await integrity(app.doc.innerHTML, app.cur?.audit || []);
  return r.status === "changed";
}

export function initCollab(ctx) {
  app = ctx;
  $("#shareBtn").addEventListener("click", openShare);
  $("#closeShare").addEventListener("click", () => closeDialog($("#shareModal")));
  $("#addSigner").addEventListener("click", () => {
    const n = $$("#signerRows .signer-row").length;
    $("#signerRows").append(signerRow(n));
    renumber();
    $$("#signerRows .signer-row")[n].querySelector("input").focus();
  });
  $("#signerRows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (b) { b.closest(".signer-row").remove(); renumber(); }
  });
  $("#createShare").addEventListener("click", createLinks);
  $("#shareList").addEventListener("click", shareListClick);
  $("#shareResult").addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) copy(signLink(c.dataset.copy));
  });

  $("#commentsBtn").addEventListener("click", () => {
    if (!app.requireDoc()) return;
    renderComments();
    openDialog($("#commentsModal"));
  });
  $("#closeComments").addEventListener("click", () => closeDialog($("#commentsModal")));
  $("#commentList").addEventListener("click", commentClick);

  $("#certBtn").addEventListener("click", openCertificate);
  $("#closeCert").addEventListener("click", () => closeDialog($("#certModal")));
  $("#certPdf").addEventListener("click", () => {
    closeDialog($("#certModal"));
    app.exportPDF();
  });
  return { openComments: () => $("#commentsBtn").click(), openCertificate };
}
