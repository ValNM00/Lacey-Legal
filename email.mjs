// Envío de correos con Resend (opcional). Sin RESEND_API_KEY no se manda nada.
import { env, escapeHTML } from "./http.mjs";

export const emailEnabled = () => !!env("RESEND_API_KEY");

export async function sendEmail({ to, subject, html, fetchImpl = fetch }) {
  if (!emailEnabled() || !to) return false;
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env("REMINDER_FROM") || "Lacey Legal <onboarding@resend.dev>", to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return true;
}

/** Plantilla de correo con el estilo de Lacey Legal. */
export function emailLayout({ greeting, paragraphs = [], button, footnote }) {
  return (
    `<div style="font-family:Arial,sans-serif;color:#4a2340;max-width:520px;line-height:1.5">` +
    `<p style="font:bold 20px Georgia,serif;color:#c23d70;margin:0 0 16px">Lacey Legal</p>` +
    (greeting ? `<h2 style="font-size:18px;margin:0 0 12px">${escapeHTML(greeting)}</h2>` : "") +
    paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join("") +
    (button
      ? `<p style="margin:20px 0"><a href="${escapeHTML(button.url)}" style="background:#e2588a;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:bold">${escapeHTML(button.label)}</a></p>`
      : "") +
    (footnote ? `<p style="font-size:12px;color:#7a5470;margin-top:24px">${footnote}</p>` : "") +
    `</div>`
  );
}

/** Correo seguro: nunca rompe el flujo si falla. */
export async function trySend(opts) {
  try {
    return await sendEmail(opts);
  } catch (err) {
    console.error("No se pudo enviar el correo:", err.message);
    return false;
  }
}
