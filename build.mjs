// Compila el frontend (src/) a public/js con esbuild.
import { build } from "esbuild";
import { rmSync, readFileSync, writeFileSync } from "node:fs";

rmSync("public/js", { recursive: true, force: true });
await build({
  entryPoints: ["src/main.js", "src/sign.js"],
  bundle: true,
  splitting: true, // html2pdf y docx se cargan solo cuando se usan
  format: "esm",
  outdir: "public/js",
  minify: true,
  sourcemap: false,
  target: ["es2020"],
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "info",
});

// En Netlify: imagen para compartir con URL absoluta y correo de contacto en las páginas legales.
if (process.env.NETLIFY) {
  const site = process.env.URL || "";
  const contact = process.env.CONTACT_EMAIL || "";
  const page = (f, fn) => writeFileSync(f, fn(readFileSync(f, "utf8")));
  if (site) {
    for (const f of ["public/index.html"]) page(f, (s) => s.replace('content="/og.png"', `content="${site}/og.png"`));
  }
  for (const f of ["public/terminos.html", "public/privacidad.html"]) {
    page(f, (s) => contact
      ? s.replaceAll("CONTACT_EMAIL", contact)
      : s.replace(/<a class="contact-email"[^>]*>CONTACT_EMAIL<\/a>/g, "los datos de contacto del sitio"));
  }
}
