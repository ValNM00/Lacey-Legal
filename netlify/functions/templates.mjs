// /api/templates — plantillas propias.
//   GET    /api/templates        → [{ id, name, fields, updated }]
//   GET    /api/templates/:id    → { id, name, html, fields, updated }
//   PUT    /api/templates/:id    { name, html } → guarda (los campos se detectan del texto: {nombre})
//   DELETE /api/templates/:id
import { getUser } from "@netlify/identity";
import { json, readJSON, str, wrap, checkOrigin, HttpError } from "../lib/http.mjs";
import { requireUser } from "../lib/auth.mjs";
import { openStore, getTemplates, putTemplates, ID_RE, MAX_TEMPLATES } from "../lib/data.mjs";

const MAX_HTML = 300_000;

/** Campos de una plantilla: todo lo que esté entre llaves, como {nombre del cliente}. */
export function templateFields(html) {
  const text = String(html).replace(/<[^>]+>/g, " ");
  const seen = new Set();
  for (const m of text.matchAll(/\{([^{}<>]{1,40})\}/g)) {
    const f = m[1].trim();
    if (f) seen.add(f);
  }
  return [...seen].slice(0, 40);
}

export const makeHandler = ({ store: storeFactory = openStore, getUser: getUserImpl = getUser } = {}) =>
  wrap(async (req, context) => {
    if (req.method !== "GET") checkOrigin(req);
    const user = await requireUser(getUserImpl);
    const store = storeFactory();
    const id = context.params?.id;
    if (id && !ID_RE.test(id)) throw new HttpError(400, "Identificador inválido.");
    const list = await getTemplates(store, user.id);

    if (req.method === "GET") {
      if (!id) return json(list.map(({ id, name, fields, updated }) => ({ id, name, fields, updated })));
      const tpl = list.find((x) => x.id === id);
      if (!tpl) throw new HttpError(404, "Plantilla no encontrada.");
      return json(tpl);
    }
    if (!id) throw new HttpError(405, "Método no permitido.");

    if (req.method === "PUT") {
      const body = await readJSON(req, MAX_HTML + 5_000);
      const name = str(body.name, 100);
      const html = typeof body.html === "string" ? body.html : "";
      if (!name) throw new HttpError(400, "Ponele un nombre a la plantilla.");
      if (!html || html.length > MAX_HTML) throw new HttpError(400, "La plantilla está vacía o es demasiado grande.");
      const i = list.findIndex((x) => x.id === id);
      if (i < 0 && list.length >= MAX_TEMPLATES) throw new HttpError(400, `Máximo ${MAX_TEMPLATES} plantillas.`);
      const tpl = { id, name, html, fields: templateFields(html), updated: Date.now() };
      if (i >= 0) list.splice(i, 1);
      list.unshift(tpl);
      await putTemplates(store, user.id, list);
      return json({ id, fields: tpl.fields, updated: tpl.updated });
    }

    if (req.method === "DELETE") {
      await putTemplates(store, user.id, list.filter((x) => x.id !== id));
      return json({ ok: true });
    }
    throw new HttpError(405, "Método no permitido.");
  });

export default makeHandler();

export const config = { path: ["/api/templates", "/api/templates/:id"] };
