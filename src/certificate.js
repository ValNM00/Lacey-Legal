// Certificado de firmas: quién firmó, cuándo, desde dónde y la huella del documento.
import { escapeHTML } from "./util.js";
import { t, getUILang, langCode } from "./i18n.js";
import { documentHash } from "../shared/integrity.mjs";

const EVENT_KEY = {
  created: "ev_created", sent: "ev_sent", viewed: "ev_viewed", signed: "ev_signed",
  "signed-here": "ev_signedHere", comment: "ev_comment", revoked: "ev_revoked",
};

export function device(ua = "") {
  if (!ua) return "";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ");
}

const fmt = (ts) => new Date(ts).toLocaleString(langCode(getUILang()), { dateStyle: "long", timeStyle: "medium" });

/** Firmas que se ven en el documento (sirve también sin cuenta). */
export function signaturesInDoc(docEl) {
  return [...docEl.querySelectorAll(".sig-block")].filter((b) => b.querySelector("img")).map((b) => ({
    name: b.querySelector(".sig-line")?.textContent.trim() || "",
    meta: b.querySelector(".sig-meta")?.textContent.trim() || "",
  }));
}

/**
 * Estado de integridad: compara la huella actual con la de la última firma.
 * → { current, signedHash, status: "ok" | "changed" | "none" }
 */
export async function integrity(html, audit = []) {
  const current = await documentHash(html);
  const lastSigned = [...audit].reverse().find((e) => (e.type === "signed" || e.type === "signed-here") && e.hash);
  if (!lastSigned) return { current, signedHash: "", status: "none" };
  return { current, signedHash: lastSigned.hash, status: lastSigned.hash === current ? "ok" : "changed" };
}

/** HTML del certificado (para el modal y para agregarlo al PDF). */
export async function certificateHTML({ title, html, audit = [], docEl }) {
  const integ = await integrity(html, audit);
  const sigs = audit.filter((e) => e.type === "signed" || e.type === "signed-here");
  const fallback = sigs.length ? [] : signaturesInDoc(docEl);
  const statusText = { ok: t("certOk"), changed: t("certChanged"), none: t("certNone") }[integ.status];

  const signerRows = sigs.length
    ? sigs.map((e) => `<tr><td><strong>${escapeHTML(e.name || "")}</strong>${e.role ? `<br><small>${escapeHTML(e.role)}</small>` : ""}${e.email ? `<br><small>${escapeHTML(e.email)}</small>` : ""}</td>
        <td>${escapeHTML(fmt(e.at))}</td>
        <td>${escapeHTML(e.type === "signed" ? t("certByLink") : t("certHere"))}</td>
        <td><small>${escapeHTML(e.ip || "—")}<br>${escapeHTML(device(e.ua))}</small></td></tr>`).join("")
    : fallback.map((s) => `<tr><td><strong>${escapeHTML(s.name)}</strong></td><td colspan="3"><small>${escapeHTML(s.meta)}</small></td></tr>`).join("");

  const events = audit.map((e) => `<tr><td>${escapeHTML(fmt(e.at))}</td><td>${escapeHTML(t(EVENT_KEY[e.type] || "ev_other"))}</td>
      <td>${escapeHTML(e.name || (e.names || []).join(", ") || e.actor || "")}</td><td><small>${escapeHTML(e.ip || "")}</small></td></tr>`).join("");

  return `<div class="cert">
    <div class="cert-head"><p class="cert-kicker">Lacey Legal</p><h2>${escapeHTML(t("certTitle"))}</h2>
      <p>${escapeHTML(title)}</p></div>
    <div class="cert-status ${integ.status}"><strong>${escapeHTML(statusText)}</strong></div>
    <h3>${escapeHTML(t("certSigners"))}</h3>
    ${signerRows ? `<table class="cert-table"><thead><tr><th>${escapeHTML(t("certPerson"))}</th><th>${escapeHTML(t("certDate"))}</th><th>${escapeHTML(t("certMethod"))}</th><th>${escapeHTML(t("certOrigin"))}</th></tr></thead><tbody>${signerRows}</tbody></table>`
      : `<p class="muted">${escapeHTML(t("certNoSigners"))}</p>`}
    <h3>${escapeHTML(t("certHash"))}</h3>
    <p class="cert-hash">${escapeHTML(integ.current)}</p>
    ${integ.status === "changed" ? `<p class="cert-hash old">${escapeHTML(t("certHashSigned"))}: ${escapeHTML(integ.signedHash)}</p>` : ""}
    ${events ? `<h3>${escapeHTML(t("certHistory"))}</h3><table class="cert-table"><tbody>${events}</tbody></table>`
      : `<p class="muted small">${escapeHTML(t("certLocal"))}</p>`}
    <p class="cert-foot">${escapeHTML(t("certFoot", { date: fmt(Date.now()) }))}</p>
  </div>`;
}
