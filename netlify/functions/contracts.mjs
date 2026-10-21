// /api/contracts — contratos de la usuaria con sesión iniciada.
//   GET    /api/contracts                         → { items, email }
//   GET    /api/contracts/:id                     → contrato + { audit, comments }
//   PUT    /api/contracts/:id                     → guardar (control de conflictos con "base")
//   PATCH  /api/contracts/:id                     → { folder } mover de carpeta (no cuenta como edición)
//   DELETE /api/contracts/:id                     → borra contrato, versiones, registro y links de firma
//   GET    /api/contracts/:id/versions            → [{ id, at, label }]
//   GET    /api/contracts/:id/versions/:vid       → { id, at, label, html }
//   PATCH  /api/contracts/:id/comments/:commentId → { status, reply } responder o resolver un comentario
import { getUser } from "@netlify/identity";
import { json, readJSON, str, wrap, checkOrigin, HttpError } from "../lib/http.mjs";
import { requireUser } from "../lib/auth.mjs";
import {
  openStore, getIndex, getContract, getVersions, saveContract, deleteContract, ID_RE, MAX_CONTRACTS,
  getLog, updateLog, addAudit, patchMeta, clientIP, userAgent,
} from "../lib/data.mjs";
import { documentHash } from "../../shared/integrity.mjs";

const MAX_HTML = 2_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUDIT_TYPES = ["signed-here"];

export const makeHandler = ({ store: storeFactory = openStore, getUser: getUserImpl = getUser } = {}) =>
  wrap(async (req, context) => {
    if (req.method !== "GET") checkOrigin(req);
    const user = await requireUser(getUserImpl, req);
    const store = storeFactory();
    const { id, vid, commentId } = context.params || {};
    const path = new URL(req.url).pathname;

    if (id && !ID_RE.test(id)) throw new HttpError(400, "Identificador inválido.");

    // Lista
    if (!id) {
      if (req.method !== "GET") throw new HttpError(405, "Método no permitido.");
      const index = await getIndex(store, user.id);
      return json({ items: index.items, email: user.email });
    }

    // Versiones
    if (path.includes("/versions")) {
      if (req.method !== "GET") throw new HttpError(405, "Método no permitido.");
      const versions = await getVersions(store, user.id, id);
      if (!vid) return json(versions.map(({ id, at, label }) => ({ id, at, label })));
      const v = versions.find((x) => x.id === vid);
      if (!v) throw new HttpError(404, "Versión no encontrada.");
      return json(v);
    }

    // Comentarios
    if (path.includes("/comments/")) {
      if (req.method !== "PATCH") throw new HttpError(405, "Método no permitido.");
      const body = await readJSON(req, 10_000);
      let found = null;
      const log = await updateLog(store, user.id, id, (l) => {
        found = l.comments.find((c) => c.id === commentId);
        if (!found) return;
        if (typeof body.reply === "string") {
          found.reply = str(body.reply, 1500);
          found.replyAt = Date.now();
        }
        if (body.status === "resolved" || body.status === "open") found.status = body.status;
      });
      if (!found) throw new HttpError(404, "Comentario no encontrado.");
      const open = log.comments.filter((c) => c.status === "open").length;
      await patchMeta(store, user.id, id, (m) => { m.openComments = open; });
      return json({ comment: found, openComments: open });
    }

    if (req.method === "GET") {
      const c = await getContract(store, user.id, id);
      if (!c) throw new HttpError(404, "Contrato no encontrado.");
      const log = await getLog(store, user.id, id);
      return json({ ...c, audit: log.audit, comments: log.comments });
    }

    if (req.method === "DELETE") {
      await deleteContract(store, user.id, id);
      return json({ ok: true });
    }

    if (req.method === "PATCH") {
      const body = await readJSON(req, 5_000);
      const c = await getContract(store, user.id, id);
      if (!c) throw new HttpError(404, "Contrato no encontrado.");
      c.folder = str(body.folder, 60);
      await store.setJSON(`users/${user.id}/c/${id}`, c);
      await patchMeta(store, user.id, id, (m) => { m.folder = c.folder; });
      return json({ ok: true, folder: c.folder });
    }

    if (req.method === "PUT") {
      const body = await readJSON(req, MAX_HTML + 50_000);
      const html = typeof body.html === "string" ? body.html : "";
      if (!html) throw new HttpError(400, "El contrato está vacío.");
      if (html.length > MAX_HTML) throw new HttpError(413, "El contrato es demasiado grande.");

      const existing = await getContract(store, user.id, id);
      if (!existing) {
        const index = await getIndex(store, user.id);
        if (index.items.length >= MAX_CONTRACTS) throw new HttpError(400, `Llegaste al máximo de ${MAX_CONTRACTS} contratos. Borrá alguno.`);
      }
      // Si alguien más lo cambió (otra pestaña o la otra parte firmó), avisamos.
      if (existing && body.base != null && existing.updated !== body.base && !body.force) {
        const log = await getLog(store, user.id, id);
        throw new HttpError(409, "El contrato cambió en otro lugar.", { conflict: true, latest: { ...existing, ...log } });
      }

      // Si un campo no viene, se conserva el valor anterior.
      const has = (f) => Object.prototype.hasOwnProperty.call(body, f);
      const endDate = has("endDate") ? (DATE_RE.test(body.endDate || "") ? body.endDate : "") : existing?.endDate || "";
      const remindDays = has("remindDays")
        ? Math.min(90, Math.max(0, parseInt(body.remindDays, 10) || 0))
        : existing?.remindDays ?? 7;
      const remindEmail = has("remindEmail") ? !!body.remindEmail : !!existing?.remindEmail;
      const contract = {
        id,
        title: str(body.title, 160) || "Contrato sin título",
        html,
        lang: str(body.lang, 60) || "Spanish",
        folder: existing ? existing.folder || "" : str(body.folder, 60),
        updated: Math.max(Date.now(), (existing?.updated || 0) + 1),
        created: existing?.created || Date.now(),
        endDate,
        remindDays,
        remindEmail: remindEmail && !!endDate,
      };
      const label = str(body.version, 120) || (existing ? "" : "Creado");
      await saveContract(store, user.id, contract, { versionLabel: label, user });

      if (!existing) await addAudit(store, user.id, id, { type: "created", actor: user.email, ip: clientIP(req, context) });
      const ev = body.auditEvent;
      if (ev && AUDIT_TYPES.includes(ev.type)) {
        await addAudit(store, user.id, id, {
          type: ev.type,
          name: str(ev.name, 80),
          role: str(ev.role, 80),
          actor: user.email,
          ip: clientIP(req, context),
          ua: userAgent(req),
          hash: await documentHash(html),
        });
      }
      return json({ updated: contract.updated });
    }

    throw new HttpError(405, "Método no permitido.");
  });

export default makeHandler();

export const config = {
  path: [
    "/api/contracts", "/api/contracts/:id", "/api/contracts/:id/versions", "/api/contracts/:id/versions/:vid",
    "/api/contracts/:id/comments/:commentId",
  ],
};
