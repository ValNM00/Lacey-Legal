// Usuaria actual a partir de la sesión de Netlify Identity (cookie nf_jwt).
import { getUser } from "@netlify/identity";
import { HttpError } from "./http.mjs";

function cookie(req, name) {
  const raw = req?.headers?.get("cookie") || "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}

const norm = (u) => (u?.id ? { id: u.id, email: u.email || "", name: u.name || u.user_metadata?.full_name || u.userMetadata?.full_name || "" } : null);

/**
 * Devuelve la usuaria con sesión o null.
 * 1. La librería oficial (@netlify/identity).
 * 2. Respaldo: le preguntamos a Netlify Identity con el token de la cookie (Netlify lo verifica).
 */
export async function resolveUser(req, getUserImpl = getUser, fetchImpl = fetch) {
  try {
    const u = norm(await getUserImpl());
    if (u) return u;
  } catch { /* probamos el respaldo */ }
  const jwt = cookie(req, "nf_jwt") || (req?.headers?.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || !req?.url) return null;
  try {
    const res = await fetchImpl(new URL("/.netlify/identity/user", req.url).href, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!res.ok) return null;
    return norm(await res.json());
  } catch {
    return null;
  }
}

export async function requireUser(getUserImpl = getUser, req) {
  const user = await resolveUser(req, getUserImpl);
  if (!user) throw new HttpError(401, "Iniciá sesión para continuar.");
  return user;
}
