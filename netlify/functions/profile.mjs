// /api/profile — datos y marca de la usuaria (salen en sus contratos).
//   GET    /api/profile   → perfil
//   PUT    /api/profile   → guarda
//   DELETE /api/account   → borra todos sus datos y su cuenta
import { getUser, admin } from "@netlify/identity";
import { json, readJSON, str, wrap, checkOrigin, HttpError } from "../lib/http.mjs";
import { requireUser } from "../lib/auth.mjs";
import { openStore, getProfile, putProfile, deleteUserData } from "../lib/data.mjs";

const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_LOGO = 220_000;

export function cleanProfile(body) {
  const logo = typeof body.logo === "string" && LOGO_RE.test(body.logo) && body.logo.length <= MAX_LOGO ? body.logo : "";
  return {
    name: str(body.name, 120),
    idNumber: str(body.idNumber, 60),
    address: str(body.address, 200),
    email: str(body.email, 254),
    phone: str(body.phone, 40),
    logo,
    useAsPartyA: !!body.useAsPartyA,
    brandExports: body.brandExports !== false,
  };
}

export const makeHandler = ({
  store: storeFactory = openStore, getUser: getUserImpl = getUser, deleteIdentityUser = (id) => admin.deleteUser(id),
} = {}) =>
  wrap(async (req) => {
    if (req.method !== "GET") checkOrigin(req);
    const user = await requireUser(getUserImpl);
    const store = storeFactory();
    const isAccount = new URL(req.url).pathname.startsWith("/api/account");

    if (isAccount) {
      if (req.method !== "DELETE") throw new HttpError(405, "Método no permitido.");
      await deleteUserData(store, user.id);
      let accountDeleted = true;
      try {
        await deleteIdentityUser(user.id);
      } catch (err) {
        accountDeleted = false;
        console.error("No se pudo borrar el usuario de Identity:", err.message);
      }
      return json({ ok: true, accountDeleted });
    }

    if (req.method === "GET") return json(await getProfile(store, user.id));
    if (req.method === "PUT") {
      const body = await readJSON(req, MAX_LOGO + 10_000);
      if (body.logo && !LOGO_RE.test(body.logo)) throw new HttpError(400, "El logo tiene que ser una imagen PNG, JPG o WEBP.");
      if (body.logo && body.logo.length > MAX_LOGO) throw new HttpError(413, "El logo es demasiado pesado.");
      const profile = cleanProfile(body);
      await putProfile(store, user.id, profile);
      return json(profile);
    }
    throw new HttpError(405, "Método no permitido.");
  });

export default makeHandler();

export const config = { path: ["/api/profile", "/api/account"] };
