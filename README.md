# Lacey Legal

Tu asistente legal con IA: creá contratos, revisalos, mandalos a firmar a varias personas, recibí pedidos de cambio y guardá todo con certificado de firmas. Con Lacey, una asistente animada que te explica todo. Hecho con Google Gemini y Netlify.

Creado por **Valeria Estrella Naranjo Mayorga**. © 2026 Todos los derechos reservados.

## Funciones

**Crear y editar**
- Generar contratos describiéndolos (también por **dictado de voz**) o con un **formulario guiado**. 10 tipos de contrato.
- Usar **tus datos de “Mi marca”** como una de las partes automáticamente.
- Editor en vivo + **IA sobre la selección**: mejorar, acortar, alargar, corregir, más formal, más simple.
- **Traducción** del contrato a cualquier idioma.
- **Plantillas propias**: guardás un contrato como plantilla, la IA convierte nombres, montos y fechas en campos `{así}`, y después solo llenás esos campos.

**Revisar y analizar**
- **Revisión con IA**: puntaje, explicación en simple, cláusulas que faltan (se agregan con un clic) y riesgos.
- **Analizar un contrato recibido** (PDF, foto o texto): resumen, fechas, montos, banderas rojas y preguntas para hacer.

**Firmar**
- **Firmar aquí** o **enviar a firmar** a hasta 8 personas, cada una con su link, **en orden** si querés.
- Con el correo de cada persona: invitación automática, aviso a la siguiente cuando firma la anterior y **recordatorios cada 3 días** (máx. 3).
- Estado de cada firma: pendiente, lo abrió, espera su turno, firmó. Botones para recordar o cancelar.
- **Pedir cambios**: quien firma selecciona una parte del contrato y deja un comentario; vos respondés y lo marcás resuelto.
- **Certificado de firmas**: quién firmó, cuándo, IP, dispositivo, historial completo y **huella digital SHA-256** del documento. Detecta si el texto cambió después de firmar. Se agrega solo al PDF y al Word.

**Organizar**
- **Panel “Mis contratos”**: estados (borrador, esperando firma, firmado, vencido), estadísticas, búsqueda, **carpetas**, orden, duplicar y borrar.
- **Versiones**: ver, **comparar en colores** con la actual y restaurar.
- **Vencimientos**: aviso en la página, archivo de calendario (.ics) y correo.
- **Exportar** a PDF y Word con **tu logo y tus datos** en el encabezado y número de página.

**Lacey, la asistente**
- Botón flotante con su cara que cambia de expresión según lo que pasa.
- **Chat** sobre el contrato abierto y sobre cómo usar la página, con botones sugeridos. Puede leer en voz alta.
- **Recorrido guiado** en la primera visita.

**Cuenta y ajustes**
- **Cuentas** con Netlify Identity (correo + contraseña o Google). Sin cuenta, todo queda en el navegador.
- **Ajustes**: Mi marca (logo y datos), tema (rosa, lila, durazno, oscuro), **uso diario de IA** y cuenta (cambiar contraseña, **borrar cuenta y datos**).
- **Límite diario de IA** para proteger tu cuota de Gemini (más alto con cuenta).
- Toda la página en **cualquier idioma**.
- Páginas de **términos**, **privacidad** y **404**, e imagen para compartir el link en redes.

## Estructura

```
public/                  → HTML, CSS, imágenes (el JS compilado va a public/js en el build)
  index.html             → la app
  firmar.html            → página pública de firma
  terminos.html, privacidad.html, 404.html
  lacey/                 → poses de Lacey (las genera tools/recortar.py)
src/                     → código del frontend (módulos)
shared/integrity.mjs     → huella digital del documento (la usan servidor y navegador)
netlify/functions/       → API serverless
  ai.mjs                 → IA (Gemini) y límite diario
  contracts.mjs          → contratos, versiones, carpetas, comentarios, auditoría
  share.mjs / sign.mjs   → enviar a firmar, firmar, pedir cambios
  templates.mjs          → plantillas
  profile.mjs            → Mi marca y borrar cuenta
  reminders.mjs          → recordatorios diarios (función programada)
netlify/lib/             → código compartido del backend
tests/                   → pruebas del backend y servidor de demo
assets-src/              → imágenes originales de Lacey
tools/recortar.py        → recorta las poses de Lacey
```

Las claves secretas **nunca** están en el frontend.

## Publicar en Netlify

1. **API key de Gemini**: sacala gratis en [Google AI Studio](https://aistudio.google.com/apikey).
2. **Importar el repo**: en Netlify, *Add new project → Import an existing project → GitHub*. Netlify lee `netlify.toml` (compila con `npm run build` y usa Node 22).
3. **Variables de entorno** (*Project configuration → Environment variables*):

   | Variable | Para qué | ¿Obligatoria? |
   |---|---|---|
   | `GEMINI_API_KEY` | Toda la IA | Sí |
   | `CONTACT_EMAIL` | Correo de contacto en Términos y Privacidad | Muy recomendada |
   | `RESEND_API_KEY` | Correos: invitaciones, recordatorios, avisos ([resend.com](https://resend.com)) | No |
   | `REMINDER_FROM` | Remitente, ej. `Lacey Legal <avisos@tudominio.com>` | Con Resend |
   | `AI_DAILY_LIMIT` | Usos de IA por día con cuenta (por defecto 100) | No |
   | `AI_DAILY_LIMIT_ANON` | Usos de IA por día sin cuenta (por defecto 30) | No |
   | `USAGE_SALT` | Texto secreto para cifrar las IP en el conteo de uso | Recomendada |
   | `GEMINI_MODEL` | Forzar un modelo de Gemini. Si no la ponés, la app usa `gemini-3.5-flash-lite` para tareas rápidas y `gemini-3.8-flash` para redactar y revisar; si uno está saturado o fue retirado, pasa sola al siguiente | No (mejor no ponerla) |

> **Muchas personas a la vez:** la cuota gratis de Gemini es por proyecto y por minuto. La app reparte el trabajo entre varios modelos, pero para uso real con varias personas al mismo tiempo conviene activar la facturación en Google AI Studio (Get API key → Set up billing): los límites suben muchísimo y el costo con estos modelos es muy bajo.


4. **Activar las cuentas**: *Project configuration → Identity → Enable Identity*. Para el botón de Google: *Identity → Registration → External providers → Google*.
5. **Deploy**: *Deploys → Trigger deploy* para que tome las variables.

Los datos se guardan en **Netlify Blobs**, sin configuración extra.

> **Correos**: con el plan gratis de Resend, si no verificás un dominio propio solo podés mandarte correos a vos misma. Para invitar y recordar a cualquier persona, verificá un dominio en Resend y usalo en `REMINDER_FROM`. Sin Resend todo funciona igual, solo que los links los mandás vos (WhatsApp, correo, copiar).

> **Páginas legales**: `terminos.html` y `privacidad.html` describen cómo funciona la app de verdad, pero son un punto de partida. Revisalas con una abogada o abogado antes de lanzar, sobre todo si vas a cobrar o tener muchas usuarias.

## Probar en tu compu

```bash
npm install
npm test        # pruebas del backend
npm run demo    # http://localhost:8777 con IA simulada y cuentas de prueba
```

`npm run demo` no usa Gemini ni Netlify: la IA responde con ejemplos y las cuentas viven en memoria. Sirve para probar toda la interfaz. Para probar con IA y cuentas reales, usá un *Deploy Preview* de Netlify (Netlify Identity no funciona con `netlify dev`).

### Cambiar o agregar poses de Lacey

1. Guardá la imagen en `assets-src/` como `lacey-<pose>-original.png` (1024×1024, fondo blanco liso, mismo encuadre).
2. Corré `python3 tools/recortar.py` (necesita `pip install pillow`).
3. Poses que usa la app: `normal`, `hablando`, `saludando`, `pensando`, `feliz`, `preocupada`, `leyendo`.

## Notas

- Los contratos generados son borradores y no reemplazan la asesoría legal profesional.
- La firma por link registra nombre, firma, fecha, IP, dispositivo y huella del documento. Para contratos que por ley exigen firma digital certificada, usá el medio que pida la ley.
