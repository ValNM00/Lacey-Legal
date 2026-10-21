// Usuaria actual a partir de la sesión de Netlify Identity (cookie nf_jwt).
import { getUser } from "@netlify/identity";
import { HttpError } from "./http.mjs";

export async function requireUser(getUserImpl = getUser) {
  const user = await getUserImpl();
  if (!user?.id) throw new HttpError(401, "Iniciá sesión para continuar.");
  return { id: user.id, email: user.email || "", name: user.name || user.userMetadata?.full_name || "" };
}
