// /api/share — la dueña manda el contrato a firmar.
//   POST   /api/share                 { cid, ordered, signers: [{ name, role, email }] } → { links: [{ token, name }] }
//   POST   /api/share/:token/remind   → reenvía la invitación por correo (si tiene correo)
//   DELETE /api/share/:token          → cancela el link
import { getUser } from "@netlify/identity";
import { json, readJSON, str, wrap, checkOrigin, escapeHTML, HttpError, env } from "../lib/http.mjs";
import { requireUser } from "../lib/auth.mjs";
import {
  openStore, getContract, getIndex, putIndex, keys, updateShareMeta, ID_RE, TOKEN_RE, newToken, addAudit, clientIP,
} from "../lib/data.mjs";
import { trySend, emailLayout, emailEnabled } from "../lib/email.mjs";

const MAX_PENDING = 15;
const MAX_SIGNERS = 8;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const signLink = (req, token) => `${env("URL") || new URL(req.url).origin}/firmar.html#${token}`;

export function inviteEmail({ ownerName, signerName, title, link, reminder = false }) {
  return {
    subject: reminder ? `Recordatorio: "${title}" espera tu firma` : `${ownerName || "Alguien"} te envió "${title}" para firmar`,
    html: emailLayout({
      greeting: `Hola ${signerName},`,
      paragraphs: [
        reminder
          ? `Te recordamos que el contrato <strong>${escapeHTML(title)}</strong> todavía espera tu firma.`
          : `<strong>${escapeHTML(ownerName || "Alguien")}</strong> te invitó a revisar y firmar el contrato <strong>${escapeHTML(title)}</strong>.`,
        "Podés leerlo, pedir cambios si algo no te convence y firmarlo desde tu celular, sin crear una cuenta.",
      ],
      button: { url: link, label: "Revisar y firmar" },
      footnote: "El link es personal y vence en 30 días. Si no esperabas este correo, podés ignorarlo.",
    }),
  };
}

export const makeHandler = ({ store: storeFactory = openStore, getUser: getUserImpl = getUser, fetchImpl = fetch } = {}) =>
  wrap(async (req, context) => {
    checkOrigin(req);
    const user = await requireUser(getUserImpl);
    const store = storeFactory();
    const token = context.params?.token || "";
    const ownerName = user.name || user.email.split("@")[0] || "";

    // Recordar
    if (req.method === "POST" && token) {
      if (!TOKEN_RE.test(token)) throw new HttpError(400, "Link inválido.");
      const share = await store.get(keys.share(token), { type: "json" });
      if (!share || share.uid !== user.id) throw new HttpError(404, "Link no encontrado.");
      if (share.status !== "pending") throw new HttpError(409, "Esta persona ya firmó.");
      if (!share.email || !emailEnabled()) return json({ emailed: false, link: signLink(req, token) });
      const contract = await getContract(store, user.id, share.cid);
      const mail = inviteEmail({ ownerName, signerName: share.signerName, title: contract?.title || "", link: signLink(req, token), reminder: true });
      const emailed = await trySend({ to: share.email, ...mail, fetchImpl });
      if (emailed) await updateShareMeta(store, user.id, share.cid, token, { lastReminder: Date.now() });
      return json({ emailed, link: signLink(req, token) });
    }

    // Crear links
    if (req.method === "POST") {
      const body = await readJSON(req, 20_000);
      const cid = str(body.cid, 64);
      if (!ID_RE.test(cid)) throw new HttpError(400, "Contrato inválido.");
      const raw = Array.isArray(body.signers) ? body.signers : [{ name: body.signerName, role: body.role, email: body.email }];
      const signers = raw.slice(0, MAX_SIGNERS + 1).map((s) => ({
        name: str(s?.name, 80), role: str(s?.role, 80), email: str(s?.email, 254).toLowerCase(),
      }));
      if (!signers.length || signers.some((s) => !s.name)) throw new HttpError(400, "Escribí el nombre de cada persona que va a firmar.");
      if (signers.length > MAX_SIGNERS) throw new HttpError(400, `Máximo ${MAX_SIGNERS} firmantes por envío.`);
      if (signers.some((s) => s.email && !EMAIL_RE.test(s.email))) throw new HttpError(400, "Hay un correo que no es válido.");

      const contract = await getContract(store, user.id, cid);
      if (!contract) throw new HttpError(404, "Guardá el contrato antes de compartirlo.");
      const index = await getIndex(store, user.id);
      const pending = (index.items.find((x) => x.id === cid)?.shares || []).filter((s) => s.status === "pending");
      if (pending.length + signers.length > MAX_PENDING) throw new HttpError(400, "Este contrato ya tiene demasiados links pendientes.");

      const ordered = !!body.ordered && signers.length > 1;
      const group = crypto.randomUUID().slice(0, 8);
      const created = Date.now();
      const links = [];
      for (const [order, s] of signers.entries()) {
        const t = newToken();
        await store.setJSON(keys.share(t), {
          uid: user.id, cid, group, order, ordered, signerName: s.name, role: s.role, email: s.email,
          ownerName, status: "pending", created,
        });
        await updateShareMeta(store, user.id, cid, t, {
          group, order, ordered, signerName: s.name, role: s.role, email: s.email, status: "pending", created,
          reminders: 0, lastReminder: created,
        });
        links.push({ token: t, name: s.name, email: s.email, order });
      }

      // Invitaciones por correo (en orden: solo la primera persona)
      let emailed = 0;
      for (const l of links) {
        if (!l.email || (ordered && l.order > 0)) continue;
        const mail = inviteEmail({ ownerName, signerName: l.name, title: contract.title, link: signLink(req, l.token) });
        if (await trySend({ to: l.email, ...mail, fetchImpl })) emailed++;
      }
      await addAudit(store, user.id, cid, {
        type: "sent", actor: user.email, ip: clientIP(req, context), ordered,
        names: signers.map((s) => s.name),
      });
      return json({ links, ordered, emailed, emailEnabled: emailEnabled() });
    }

    // Cancelar
    if (req.method === "DELETE") {
      if (!TOKEN_RE.test(token)) throw new HttpError(400, "Link inválido.");
      const share = await store.get(keys.share(token), { type: "json" });
      if (!share || share.uid !== user.id) throw new HttpError(404, "Link no encontrado.");
      await store.delete(keys.share(token));
      const index = await getIndex(store, user.id);
      const meta = index.items.find((x) => x.id === share.cid);
      if (meta) {
        meta.shares = (meta.shares || []).filter((s) => s.token !== token);
        await putIndex(store, user.id, index);
      }
      await addAudit(store, user.id, share.cid, { type: "revoked", name: share.signerName, actor: user.email });
      return json({ ok: true });
    }

    throw new HttpError(405, "Método no permitido.");
  });

export default makeHandler();

export const config = { path: ["/api/share", "/api/share/:token", "/api/share/:token/remind"] };
