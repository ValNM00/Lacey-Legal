// Función programada (todos los días):
//  1. Avisa por correo a la dueña cuando un contrato está por vencer.
//  2. Recuerda a quienes todavía no firmaron (cada 3 días, máximo 3 veces).
// Variables: RESEND_API_KEY y REMINDER_FROM (ej. "Lacey Legal <avisos@tudominio.com>").
import { env, escapeHTML } from "../lib/http.mjs";
import { openStore, getIndex, putIndex, getContract } from "../lib/data.mjs";
import { sendEmail, emailLayout } from "../lib/email.mjs";
import { inviteEmail } from "./share.mjs";

const DAY = 24 * 60 * 60 * 1000;
const SIGNER_EVERY = 3 * DAY;
const SIGNER_MAX = 3;
const LINK_TTL = 30 * DAY;

export function daysLeft(endDate, now = Date.now()) {
  const end = Date.parse(endDate + "T23:59:59Z");
  return Math.ceil((end - now) / DAY) - 1;
}

export async function runReminders({ store, now = Date.now(), fetchImpl = fetch, siteUrl = env("URL") || "" }) {
  const { blobs } = await store.list({ prefix: "users/" });
  const indexKeys = blobs.map((b) => b.key).filter((k) => k.endsWith("/index"));
  let sent = 0;

  for (const key of indexKeys) {
    const uid = key.split("/")[1];
    const index = await getIndex(store, uid);
    let changed = false;

    for (const item of index.items) {
      // 1. Vencimientos
      if (index.email && item.remindEmail && item.endDate && item.remindedFor !== item.endDate) {
        const left = daysLeft(item.endDate, now);
        if (left >= 0 && left <= (item.remindDays ?? 7)) {
          const when = left === 0 ? "vence hoy" : left === 1 ? "vence mañana" : `vence en ${left} días`;
          try {
            await sendEmail({
              fetchImpl,
              to: index.email,
              subject: `Tu contrato "${item.title}" ${when}`,
              html: emailLayout({
                greeting: `Hola${index.name ? " " + index.name : ""},`,
                paragraphs: [
                  `Te recordamos que el contrato <strong>${escapeHTML(item.title)}</strong> ${when} (${escapeHTML(item.endDate)}).`,
                  "Es buen momento para renovarlo, cerrarlo o revisar los pendientes.",
                ],
                button: siteUrl ? { url: siteUrl, label: "Abrir Lacey Legal" } : null,
                footnote: "Podés desactivar este aviso desde el contrato, en “Vencimiento”.",
              }),
            });
            item.remindedFor = item.endDate;
            changed = true;
            sent++;
          } catch (err) {
            console.error("No se pudo enviar el recordatorio:", err.message);
          }
        }
      }

      // 2. Firmas pendientes
      for (const s of item.shares || []) {
        if (s.status !== "pending" || !s.email || !siteUrl) continue;
        if (now - s.created > LINK_TTL || (s.reminders || 0) >= SIGNER_MAX) continue;
        if (now - (s.lastReminder || s.created) < SIGNER_EVERY) continue;
        if (s.ordered && (item.shares || []).some((o) => o.group === s.group && o.order < s.order && o.status === "pending")) continue;
        try {
          const contract = await getContract(store, uid, item.id);
          const mail = inviteEmail({
            ownerName: index.name || index.email?.split("@")[0], signerName: s.signerName,
            title: contract?.title || item.title, link: `${siteUrl}/firmar.html#${s.token}`, reminder: true,
          });
          await sendEmail({ fetchImpl, to: s.email, ...mail });
          s.reminders = (s.reminders || 0) + 1;
          s.lastReminder = now;
          changed = true;
          sent++;
        } catch (err) {
          console.error("No se pudo recordar a quien firma:", err.message);
        }
      }
    }
    if (changed) await putIndex(store, uid, index);
  }
  return sent;
}

export default async () => {
  if (!env("RESEND_API_KEY")) {
    console.log("RESEND_API_KEY no configurada: no se envían recordatorios por correo.");
    return;
  }
  const sent = await runReminders({ store: openStore() });
  console.log(`Recordatorios enviados: ${sent}`);
};

export const config = { schedule: "@daily" };
