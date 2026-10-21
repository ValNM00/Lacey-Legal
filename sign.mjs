// /api/sign/:token — página pública de firma (sin sesión).
//   GET                  → { title, html, signerName, role, ownerName, status, signedAt, comments, waitingFor }
//   POST                 { name, signature, agree }     → agrega la firma al contrato de la dueña
//   POST /comment        { text, quote }                → pedir cambios
import { json, readJSON, str, wrap, checkOrigin, escapeHTML, HttpError, env } from "../lib/http.mjs";
import {
  openStore, getContract, saveContract, keys, updateShareMeta, getIndex, getLog, updateLog, patchMeta,
  TOKEN_RE, clientIP, userAgent,
} from "../lib/data.mjs";
import { documentHash } from "../../shared/integrity.mjs";
import { trySend, emailLayout } from "../lib/email.mjs";
import { inviteEmail, signLink } from "./share.mjs";

const TTL = 30 * 24 * 60 * 60 * 1000; // los links vencen a los 30 días
const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

/** Si las firmas van en orden, ¿quién falta antes que esta persona? */
async function waitingFor(store, share) {
  if (!share.ordered) return [];
  const index = await getIndex(store, share.uid);
  const shares = index.items.find((x) => x.id === share.cid)?.shares || [];
  return shares
    .filter((s) => s.group === share.group && s.order < share.order && s.status === "pending")
    .map((s) => s.signerName);
}

export const makeHandler = ({ store: storeFactory = openStore, now = () => Date.now(), fetchImpl = fetch } = {}) =>
  wrap(async (req, context) => {
    const token = context.params?.token || "";
    if (!TOKEN_RE.test(token)) throw new HttpError(400, "Link inválido.");
    const store = storeFactory();
    const share = await store.get(keys.share(token), { type: "json" });
    if (!share) throw new HttpError(404, "Este link no existe o fue cancelado.");
    const expired = share.status === "pending" && now() - share.created > TTL;
    const isComment = new URL(req.url).pathname.endsWith("/comment");

    if (req.method === "GET") {
      const contract = await getContract(store, share.uid, share.cid);
      if (!contract) throw new HttpError(404, "El contrato ya no existe.");
      const log = await getLog(store, share.uid, share.cid);
      if (!share.viewedAt && share.status === "pending") {
        share.viewedAt = now();
        await store.setJSON(keys.share(token), share);
        await updateLog(store, share.uid, share.cid, (l) =>
          l.audit.push({ at: share.viewedAt, type: "viewed", name: share.signerName, ip: clientIP(req, context), ua: userAgent(req) }));
        await updateShareMeta(store, share.uid, share.cid, token, { viewedAt: share.viewedAt });
      }
      const waiting = share.status === "pending" ? await waitingFor(store, share) : [];
      return json({
        title: contract.title,
        html: contract.html,
        lang: contract.lang,
        signerName: share.signerName,
        role: share.role,
        ownerName: share.ownerName,
        status: expired ? "expired" : waiting.length ? "waiting" : share.status,
        waitingFor: waiting,
        signedAt: share.signedAt || null,
        comments: log.comments
          .filter((c) => c.token === token)
          .map(({ id, text, quote, at, status, reply, replyAt }) => ({ id, text, quote, at, status, reply, replyAt })),
      });
    }

    if (req.method !== "POST") throw new HttpError(405, "Método no permitido.");
    checkOrigin(req);
    if (expired) throw new HttpError(410, "Este link venció. Pedile a la otra parte uno nuevo.");

    // Pedir cambios
    if (isComment) {
      if (share.status !== "pending") throw new HttpError(409, "Este contrato ya fue firmado con este link.");
      const body = await readJSON(req, 20_000);
      const text = str(body.text, 1500);
      const quote = str(body.quote, 600);
      if (text.length < 2) throw new HttpError(400, "Escribí qué te gustaría cambiar.");
      const log = await getLog(store, share.uid, share.cid);
      if (log.comments.filter((c) => c.token === token).length >= 20) throw new HttpError(429, "Ya enviaste muchos comentarios con este link.");
      const comment = { id: crypto.randomUUID().slice(0, 12), token, name: share.signerName, text, quote, at: now(), status: "open" };
      const updated = await updateLog(store, share.uid, share.cid, (l) => {
        l.comments.push(comment);
        l.audit.push({ at: comment.at, type: "comment", name: share.signerName, ip: clientIP(req, context) });
      });
      const open = updated.comments.filter((c) => c.status === "open").length;
      await patchMeta(store, share.uid, share.cid, (m) => { m.openComments = open; });

      const index = await getIndex(store, share.uid);
      const contract = await getContract(store, share.uid, share.cid);
      await trySend({
        fetchImpl,
        to: index.email,
        subject: `${share.signerName} pidió cambios en "${contract?.title || ""}"`,
        html: emailLayout({
          greeting: `Hola${index.name ? " " + index.name : ""},`,
          paragraphs: [
            `<strong>${escapeHTML(share.signerName)}</strong> dejó un comentario en <strong>${escapeHTML(contract?.title || "")}</strong>:`,
            (quote ? `<em>"${escapeHTML(quote)}"</em><br>` : "") + escapeHTML(text),
          ],
          button: env("URL") ? { url: env("URL"), label: "Abrir Lacey Legal" } : null,
        }),
      });
      return json({ comment: { id: comment.id, text, quote, at: comment.at, status: "open" } });
    }

    // Firmar
    if (share.status !== "pending") throw new HttpError(409, "Este contrato ya fue firmado con este link.");
    const waiting = await waitingFor(store, share);
    if (waiting.length) throw new HttpError(409, `Todavía falta que firme: ${waiting.join(", ")}.`);
    const body = await readJSON(req, 400_000);
    const name = str(body.name, 80);
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!body.agree) throw new HttpError(400, "Tenés que aceptar firmar electrónicamente.");
    if (!name) throw new HttpError(400, "Escribí tu nombre completo.");
    if (!SIG_RE.test(signature) || signature.length > 350_000) throw new HttpError(400, "La firma no es válida. Dibujala de nuevo.");

    const contract = await getContract(store, share.uid, share.cid);
    if (!contract) throw new HttpError(404, "El contrato ya no existe.");

    const signedAt = now();
    const hash = await documentHash(contract.html);
    const date = new Date(signedAt).toISOString().slice(0, 10);
    const block =
      `<div class="sig-block"><img src="${signature}" alt="${escapeHTML("Firma de " + name)}">` +
      `<p class="sig-line">${escapeHTML(name)}</p>` +
      `<p class="sig-meta">${escapeHTML((share.role ? share.role + " · " : "") + date + " · firma electrónica")}</p></div>`;
    const heading = contract.html.includes('class="signatures"') ? "" : "<h2>Firmas</h2>";
    contract.html = `${contract.html}${heading}<div class="signatures">${block}</div>`;
    contract.updated = Math.max(signedAt, contract.updated + 1);

    await saveContract(store, share.uid, contract, { versionLabel: `Firmado por ${name}` });
    await store.setJSON(keys.share(token), { ...share, status: "signed", signedAt, signedName: name });
    await updateShareMeta(store, share.uid, share.cid, token, { status: "signed", signedAt, signedName: name });
    await updateLog(store, share.uid, share.cid, (l) => l.audit.push({
      at: signedAt, type: "signed", name, role: share.role, email: share.email || "",
      ip: clientIP(req, context), ua: userAgent(req), hash, method: "link",
    }));

    // Avisos: a la siguiente persona (si van en orden) y a la dueña
    const index = await getIndex(store, share.uid);
    const shares = index.items.find((x) => x.id === share.cid)?.shares || [];
    if (share.ordered) {
      const next = shares.find((s) => s.group === share.group && s.order === share.order + 1 && s.status === "pending");
      if (next?.email) {
        await trySend({ fetchImpl, to: next.email, ...inviteEmail({ ownerName: share.ownerName, signerName: next.signerName, title: contract.title, link: signLink(req, next.token) }) });
      }
    }
    const left = shares.filter((s) => s.status === "pending").length;
    await trySend({
      fetchImpl,
      to: index.email,
      subject: left ? `${name} firmó "${contract.title}"` : `"${contract.title}" ya tiene todas las firmas`,
      html: emailLayout({
        greeting: `Hola${index.name ? " " + index.name : ""},`,
        paragraphs: [
          `<strong>${escapeHTML(name)}</strong> firmó <strong>${escapeHTML(contract.title)}</strong>.`,
          left ? `Faltan ${left} firma(s).` : "Ya firmaron todas las personas. Podés descargar el PDF con el certificado de firmas.",
        ],
        button: env("URL") ? { url: env("URL"), label: "Abrir Lacey Legal" } : null,
      }),
    });
    return json({ ok: true, signedAt, hash });
  });

export default makeHandler();

export const config = { path: ["/api/sign/:token", "/api/sign/:token/comment"] };
