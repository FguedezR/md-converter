# MD Converter (md.ferguedez.dev)

Conversor de documentos a Markdown con lector de `.md` integrado. Todo se procesa en el
navegador; no se sube nada a ningún servidor. Se publica en GitHub (FguedezR/md-converter) y se
aloja en Cloudflare Pages.
Hermano del WebP Converter (https://webp.ferguedez.dev/) y del Video Converter
(https://video.ferguedez.dev/), de los que hereda estructura, estilo y front. Herramienta
pública: interfaz en **inglés** (los otros dos están en español).

## Estructura

```
index.html          # una sola página, lang="en", data-accent="amber"
style.css           # tokens en :root, sin preprocesador
app.js              # UI, estado, orquestación (script clásico, al final de <body>)
detect.js           # detectFormat(bytes, name): funciones puras, sin DOM
postprocess.js      # normalizeMarkdown(md, opts): funciones puras, sin DOM
convert.js          # registro de conversores, loadScript y convertDocument (sin UI; lo comparte test.html)
reader.js           # renderizado del lector (marked + DOMPurify), índice, vistas
converters/         # un archivo por familia; cada uno llama a registerConverter({...})
  html.js  txt.js  docx.js  pdf.js  pptx.js  odf.js  abw.js  pandoc.js  ole.js
  ocr.js            # OCR con tesseract.js; lo carga pdf.js solo si el usuario acepta
  zipxml.js         # utilidades compartidas de PPTX y ODF (JSZip + XML); va aparte para no duplicar nombres globales
workers/
  pandoc-worker.js  # ejecuta pandoc.wasm fuera del hilo principal
vendor/             # librerías de terceros minificadas, versión fijada en el nombre
fonts/              # GeistMono-Variable.woff2, GeistPixel-Square.woff2 + LICENSE-Geist-OFL.txt
test.html           # banco de pruebas en el navegador (ver «Pruebas»)
<formato>-to-markdown/index.html, markdown-viewer/index.html, 404.html, sitemap.xml
                    # GENERADOS por tools/pages.mjs a partir de index.html: no editar a mano
tools/pages.mjs     # generador de páginas por formato (Node, sin dependencias; ver «Páginas y SEO»)
tools/og.html/.css/.js  # plantilla de las imágenes Open Graph
og/                 # imágenes Open Graph 1200×630 (default.png + una por página)
robots.txt
test.js             # lógica del banco (archivo aparte: la CSP no permite scripts en línea)
favicon.svg / favicon.ico
_headers            # cabeceras de Cloudflare Pages (CSP incluida)
.gitignore          # .DS_Store, _test/ y .wrangler/ (estado local de wrangler)
.claude/CLAUDE.md   # este archivo (fuera de la publicación por .assetsignore)
wrangler.jsonc      # configuración del Worker de assets estáticos que sirve el sitio
.assetsignore       # lo que no se publica
```

- **Sin build step**: nada de package.json, npm, bundler, TypeScript ni frameworks. Lo que
  hay en el repo es exactamente lo que se despliega (raíz del repo, sin comando de build).
- Librerías en `vendor/`, nunca desde CDN público. Versión fijada y con al menos dos semanas de
  antigüedad al añadirla; conservar la licencia junto al archivo si la exige.
- Consultar la documentación o los `.d.ts` de la versión fijada antes de usar cualquier API; no
  asumirla de memoria.
- Carga bajo demanda: `loadScript(src)` (promesa cacheada por URL) para bundles IIFE/UMD;
  `import()` dinámico solo para librerías que únicamente se publican como ES module (pdf.js).
  Nada pesado en la carga inicial: la página arranca solo con `app.js`, `detect.js`,
  `postprocess.js`, `convert.js`, `reader.js`, marked y DOMPurify (el JSON-LD del `<head>` es un
  bloque de datos: la CSP no lo bloquea). Los propios conversores
  también se cargan bajo demanda (`CONVERTER_SCRIPTS` en `convert.js`).
- Prohibido LibreOffice WASM y cualquier conversión en servidor.

### Excepción: pandoc.wasm
Pesa 59,4 MiB sin comprimir y Cloudflare Pages no admite archivos de más de 25 MiB, así que **no
va en el repo**. Se aloja en R2 con dominio propio (`assets.ferguedez.dev/pandoc/<versión>/`),
con CORS limitado a `https://md.ferguedez.dev` (y localhost en desarrollo) y
`Cache-Control: public, max-age=31536000, immutable`. Solo se descarga cuando el usuario
convierte RTF, RST o TEX, con barra de progreso y aviso del tamaño antes de empezar. Es el único
recurso externo permitido; la URL vive en una constante `PANDOC_BASE` en `converters/pandoc.js`.

## Librerías previstas (fijar versión al añadirlas)

| Uso | Librería | Carga |
|---|---|---|
| Lector | marked (GFM), DOMPurify | inicial |
| HTML → MD | turndown + turndown-plugin-gfm | bajo demanda |
| DOCX/DOCM | mammoth (build browser) → HTML → turndown | bajo demanda |
| PDF | pdfjs-dist (ESM, con su worker) | `import()` bajo demanda |
| PPTX/PPSX/PPTM, ODT/ODP | JSZip + DOMParser propio | bajo demanda |
| DOC/PPT/PPS/WPS/DPS (OLE) | cfb (SheetJS) + extractor propio | bajo demanda |
| RTF/RST/TEX | pandoc.wasm + su puente JS oficial | worker, bajo demanda |
| Resaltado de código en el lector | highlight.js (subconjunto de lenguajes) | bajo demanda |
| OCR de PDF escaneados (fase 5) | tesseract.js + núcleo wasm + modelos de idioma | worker, bajo demanda |

## Decisiones de la fase 0 (2026-11-17)

### 1. Versiones fijadas y archivos en `vendor/`
Todas tenían al menos dos semanas al elegirlas. Para actualizar una, repetir la comprobación
(fecha en el registro de npm, archivo de distribución, ausencia de `eval`/`new Function` en
rutas que se ejecuten) y cambiar el nombre del archivo.

| Librería | Versión | Archivo en `vendor/` | Formato | Licencia |
|---|---|---|---|---|
| marked | 18.1.3 | `marked-18.1.3.umd.js` (no se publica minificado) | UMD, global `marked` | MIT |
| DOMPurify | 3.4.17 | `purify-3.4.17.min.js` | UMD, global `DOMPurify` | MPL-2.0 o Apache-2.0 |
| turndown | 7.2.4 | `turndown-7.2.4.js` | IIFE, global `TurndownService` | MIT |
| turndown-plugin-gfm | 1.0.2 | `turndown-plugin-gfm-1.0.2.js` (solo listas de tareas y código resaltado; tablas propias) | IIFE | MIT |
| mammoth | 1.13.0 | `mammoth-1.13.0.browser.min.js` | UMD, global `mammoth` | BSD-2 |
| pdfjs-dist | 6.5.438 | `pdfjs-6.5.438/` (`pdf.min.mjs`, `pdf.worker.min.mjs`, `cmaps/`, `standard_fonts/`, `wasm/`, `iccs/`) | **solo ESM** | Apache-2.0 |
| JSZip | 3.10.2 | `jszip-3.10.2.min.js` | UMD, global `JSZip` | MIT o GPL-3 |
| highlight.js | 11.12.0 | `highlight-11.12.0.min.js` (`@highlightjs/cdn-assets`, ~35 lenguajes comunes) | IIFE | BSD-3 |
| browser_wasi_shim | 0.3.0 (la que fija el puente de pandoc) | `browser_wasi_shim-0.3.0/` | **solo ESM** | MIT o Apache-2.0 |
| cfb | 1.2.2 | `cfb-1.2.2.min.js` | UMD, global `CFB` | Apache-2.0 |
| tesseract.js | 7.0.0 | `tesseract-7.0.0/` (`tesseract.min.js`, `worker.min.js`) | UMD, global `Tesseract` | Apache-2.0 |
| tesseract.js-core | **7.0.0** (no la 6.1.2 que npm marca `latest`: tesseract.js 7 pide las variantes relaxed-SIMD) | `tesseract-core-7.0.0/` (solo las tres `*-lstm.wasm.js`) | wasm | Apache-2.0 |
| modelos de idioma | `@tesseract.js-data/<idioma>` 1.0.0, variante `4.0.0_best_int` | `tessdata-4.0.0_best_int/` (eng, spa, fra, deu, ita, por) | `.traineddata.gz` | MIT (paquete) / Apache-2.0 (modelos) |

- Solo ESM: pdf.js (se carga con `import()`) y browser_wasi_shim (lo importa el worker de pandoc,
  que por eso es un worker de módulo).
- El fork `@joplin/turndown-plugin-gfm` solo se publica como CommonJS: no sirve sin build.
- `turndown-plugin-gfm` deja como HTML las tablas sin cabecera y no entiende `colspan`/`rowspan`;
  por eso las tablas las resuelve `converters/html.js`.

### 2. pandoc.wasm
- Versión **3.13** (2026-10-26), del zip oficial `pandoc-3.13-wasm.zip` de las releases de
  GitHub (jgm/pandoc): `pandoc.wasm` + `COPYRIGHT` + `COPYING.md`. La 3.9 fue la primera con
  build wasm oficial.
- Tamaño: 62.239.019 bytes (59,4 MiB) sin comprimir; Cloudflare lo sirve con brotli y por la red
  pasan 16,6 MB (medido el 2026-11-17; brotli -11 local daría ~11,3 MB, pero el CDN usa un nivel rápido).
  La constante `PANDOC_WASM_BYTES` guarda el tamaño exacto para la barra de progreso (con
  compresión en tránsito no llega `Content-Length` útil).
- Puente: `wasm/pandoc.js` del repo de pandoc (MIT, licencia en
  `vendor/LICENSE-pandoc-js-bridge.txt`), adaptado en `workers/pandoc-worker.js`: importa el shim
  desde `vendor/` en vez de jsDelivr, descarga con progreso y guarda el binario en Cache Storage.
- WASI de un solo hilo: **no** necesita SharedArrayBuffer ni COOP/COEP; solo
  `'wasm-unsafe-eval'` (ya en la CSP).
- Formatos de entrada usados: `rtf`, `rst`, `latex`; salida `gfm` con `wrap: none`.
- Cancelar = `worker.terminate()`; la siguiente conversión reinstancia desde la caché.
- Licencia GPL-2.0+: se distribuye el binario sin modificar, con su `COPYRIGHT` y enlace al
  código fuente de la release.

### 3. DOCM con mammoth
Funciona sin cambios: mammoth localiza el documento principal por la relación `officeDocument`
de `_rels/.rels` (con `word/document.xml` como alternativa) y no mira el content type. Las
macros (`vbaProject.bin`) nunca se leen. Solo `detect.js` distingue
`application/vnd.ms-word.document.macroEnabled.main+xml`.

### 4. Cloudflare R2 (lo configura el usuario)
1. R2 → Create bucket `ferguedez-assets` (Automatic, Standard). Acceso público por `r2.dev`
   desactivado.
2. Bucket → Settings → Custom Domains → `assets.ferguedez.dev` (esperar a *Active*).
3. Settings → CORS policy:
   ```json
   [{"AllowedOrigins":["https://md.ferguedez.dev","http://localhost:8000","http://127.0.0.1:8000"],
     "AllowedMethods":["GET","HEAD"],"ExposeHeaders":["Content-Length","ETag"],"MaxAgeSeconds":86400}]
   ```
4. Subida con metadatos (el dashboard no permite fijar `Cache-Control`):
   `npx wrangler r2 object put ferguedez-assets/pandoc/3.13/pandoc.wasm --file pandoc.wasm --content-type application/wasm --cache-control "public, max-age=31536000, immutable" --remote`,
   más `COPYRIGHT` y `COPYING.md` en la misma carpeta.
5. Cache Rule de la zona: hostname `assets.ferguedez.dev` → *Eligible for cache*, Edge TTL
   «respect origin».
6. Comprobar dos veces seguidas:
   `curl -sI -H "Origin: https://md.ferguedez.dev" -H "Accept-Encoding: br" https://assets.ferguedez.dev/pandoc/3.13/pandoc.wasm`
   → 200, `content-type: application/wasm`, el `cache-control`, `access-control-allow-origin`
   correcto y `content-encoding: br|gzip`. La caché del CDN solo se ve con `GET` (con `HEAD`
   siempre sale `DYNAMIC`): `curl -s -D - -o /dev/null -H "Origin: https://md.ferguedez.dev" -H "Accept-Encoding: br" <url>`
   debe dar `cf-cache-status: HIT` la segunda vez. Repetir con `Origin: http://localhost:8000`
   para confirmar que la caché no sirve un CORS equivocado (se guarda una copia por origen).
   Comprobado el 2026-11-17: todo correcto; por la red pasan 16,6 MB.

Mientras el bucket no exista, en local se prueba con `?localpandoc` (solo en localhost), que
lee `_test/pandoc/pandoc.wasm`.

### 5. Archivos de prueba
`_test/manifest.json`: `{ "defaults": {…opciones}, "cases": [{ "file", "expected", "format"?,
"options"?, "expectWarnings"?: [subcadenas], "expectImages"?: n, "expectError"?: true }] }`.
`format` fuerza el selector; la fecha del front matter se fija para que la salida sea estable.
Archivos reales que debe aportar el usuario, como mínimo:
- PDF de texto (títulos de varios tamaños, párrafos partidos, palabras con guion de corte), PDF
  escaneado, PDF con cabecera y pie repetidos (3 páginas o más).
- DOCX con H1–H3, listas, tabla, imágenes con y sin alt, enlaces, negrita/cursiva; DOCX con
  celdas combinadas; un DOCM.
- PPTX con títulos y notas del orador; un PPSX; un PPTM.
- HTML de una página real; HTML con `<script>`, `on*=` y `javascript:`.
- TXT en UTF-8 y en Windows-1252.
- Un archivo de cada uno de ODT, ODP, ABW, ZABW, RTF, RST y TEX.
- Fase 3: DOC, PPT y WPS/DPS de Kingsoft.

## Contrato de conversores

Cada archivo de `converters/` registra uno o varios formatos:

```js
registerConverter({
  id: "docx",                       // único
  label: "Word (DOCX)",
  extensions: ["docx", "docm"],
  load: () => loadScript("vendor/mammoth-x.y.z.min.js"),
  convert: async (buffer, opts, ctx) => ({ markdown, warnings: [], images: [], title })
});
```

- `ctx.progress(0..1)` para informar del avance; `ctx.signal` (AbortSignal) para cancelar.
- `ctx.status(texto)` cambia el texto de la fila (p. ej. «Downloading pandoc… 12 MB of 59.4 MB»);
  `await ctx.confirm(mensaje)` pide permiso antes de algo costoso (la app muestra un aviso con
  Download/Skip; test.html acepta siempre).
- `opts`: `frontMatter`, `speakerNotes`, `includeImages` (solo llega `true` a los formatos de
  `IMAGE_FORMATS`) y `sourceFormat` (el formato elegido, para conversores que sirven a varios).
- Las imágenes se numeran con `createImageSink(include)` de `postprocess.js`: devuelve el enlace
  `![alt](images/image-NNN.ext)` o el marcador, rellena `images` y genera el aviso de omitidas.
  El lector muestra las extraídas con URLs `blob:` (permitidas por la CSP).
- Los nombres globales de cada conversor no pueden repetirse entre archivos (son scripts
  clásicos): lo común va en `postprocess.js` o `converters/zipxml.js`.
- `images`: `[{ name: "image-003.png", blob, alt }]`. En el MVP se ignoran (ver «Imágenes»).
- `warnings`: frases cortas en inglés para el usuario («Tables were flattened», «3 images omitted»).
- Ningún conversor toca el DOM de la página ni hace `fetch` salvo pandoc a `PANDOC_BASE`.
- `title` (opcional): título de las propiedades del documento, para el front matter.
- Toda salida pasa por `normalizeMarkdown()` antes de mostrarse.
- El HTML ajeno se pasa por `neutralizeInlineHtml()` antes de DOMParser/DOMPurify: DOMParser
  hereda la CSP y cada `style=`/`on*=` deja un aviso en consola aunque no se ejecute.

## Detección de formato (`detect.js`)

Por firma de bytes primero, extensión como desempate. El selector «Source format: Auto | …»
siempre permite forzarlo.

| Firma | Resultado |
|---|---|
| `%PDF` | pdf |
| `PK\x03\x04` | ZIP: leer `[Content_Types].xml` (docx/docm/pptx/ppsx/pptm según content type) o `mimetype` (odt/odp) |
| `D0 CF 11 E0 A1 B1 1A E1` | OLE: stream `WordDocument` → doc (o wps de Kingsoft); `PowerPoint Document` → ppt/pps (o dps de Kingsoft); `CONTENTS`/`MN0` → wps de Microsoft Works (**no soportado**) |
| `{\rtf` | rtf |
| `1F 8B` | gzip → si al descomprimir empieza por XML con `<abiword` → zabw |
| `<abiword` / `<?xml` + `<abiword` | abw |
| `<!doctype html` / `<html` | html |
| `\documentclass` / `\begin{document}` | tex |
| `.rst`, `.txt`, `.md` | por extensión (texto); `.md` abre directamente el lector |

## Formatos

- **Soportados**: PDF, DOCX, DOCM, HTML, TXT, PPTX, PPSX, PPTM, ODT, ODP, ABW, ZABW, RTF, RST,
  TEX, MD (solo lectura).
- **Solo texto** (fase 3): DOC, PPT, PPS y WPS/DPS de Kingsoft. Se avisa de que se pierden
  títulos, tablas y formato. Implementado en `converters/ole.js`:
  - DOC: texto del documento principal por la tabla de piezas (Clx) del FIB; piezas en
    Windows-1252 o UTF-16LE. De los campos se queda el resultado y de `HYPERLINK` el enlace;
    `\x01`/`\x08` son marcadores de imagen. Notas al pie, cabeceras y pies no se extraen.
    Word 6/95 (firma `0xA5DC` o nFib < 0xC1) y los cifrados dan un mensaje propio.
  - PPT/PPS: directorio de persistencia (Current User → UserEditAtom → PersistDirectoryAtom)
    para respetar el orden real de las diapositivas; texto de los marcadores
    (SlideListWithText) y de los cuadros de texto del dibujo. Las notas se enlazan por el
    `slideId` del SlidePersistAtom, no por id de persistencia. Si el directorio no se puede leer,
    todo el texto en una sola sección.
  - Título del front matter desde `\x05SummaryInformation` (con su página de códigos).
  - WPS/DPS de Kingsoft: mismo camino que DOC/PPT si el contenedor trae `WordDocument` o
    `PowerPoint Document`; si no, mensaje para guardarlo como DOCX/PPTX. Probado el 2026-11-17
    con archivos de WPS Office para Mac: misma estructura que DOC/PPT (más un stream
    `WpsCustomData` que se ignora).
- **No soportados**: WPD, LWP, WPS de Microsoft Works. Mensaje claro: «This format can't be
  converted in the browser. Save it as DOCX in your word processor and convert that file.» No
  se intenta ninguna conversión parcial.

## OCR (fase 5)

- Solo para PDF. Una página cuenta como escaneada si no tiene texto, o si tiene alguna imagen y
  su único texto está en la franja de cabecera o pie (fechas o números de página que estampan
  los escáneres). Si hay alguna, `ctx.confirm` muestra el aviso con el idioma y el tamaño de la
  primera descarga (núcleo ~3,7 MB + modelo); Skip deja el comportamiento anterior.
- Todo se sirve desde `vendor/` (ningún archivo pasa de 25 MiB): no hace falta R2. tesseract
  guarda el modelo en IndexedDB; el núcleo, la caché HTTP.
- Worker clásico desde nuestro dominio (`workerBlobURL: false`); con la CSP actual no da avisos.
- Las páginas se renderizan con pdf.js a ~2400 px en el lado largo (OffscreenCanvas) y solo se
  pasan por OCR las escaneadas; la imagen de esas páginas no deja marcador.
- Párrafos y títulos se rehacen en `ocrBlocks()` (pdf.js) con las cajas de las líneas: nuevo
  párrafo si la distancia entre los bordes superiores de dos líneas supera en un 30 % el
  interlineado típico (cuartil inferior); título si la línea es un 30 % más alta que el cuerpo. Las
  líneas sin letras ni números o con confianza < 30 se descartan.
- Cancelar: `worker.terminate()` no rechaza el trabajo en curso, así que cada espera compite con
  la señal de cancelación (`orCancel` en `ocr.js`).
- Idioma: selector «OCR language» (preferencia guardada; si no hay, el del navegador). Cambiarlo
  invalida los PDF ya convertidos. En `test.html` el OCR está desactivado salvo que el caso ponga
  `"options": { "ocr": true, "ocrLang": "…" }`.

## Reglas de dominio (no cambiar sin consultar)

- Salida GFM: títulos ATX (`#`), listas con `-`, código con ``` y lenguaje si se conoce, tablas
  GFM; si una tabla tiene celdas combinadas, se aplana y se avisa.
- Una línea en blanco entre bloques; sin espacios finales; termina en salto de línea.
- Front matter opcional (desactivado por defecto): `title`, `source` (nombre de archivo), `converted` (fecha ISO).
- Presentaciones: `## Slide N — <título>` por diapositiva; notas del orador opcionales como
  bloque `> Notes:`.
- PDF: títulos por tamaño de fuente relativo al cuerpo dominante; unir líneas partidas y
  palabras cortadas con guion; quitar cabeceras/pies repetidos en todas las páginas. Si el PDF
  no tiene capa de texto, avisar («This PDF looks scanned…») en vez de devolver vacío.
- Nombre de salida: `[nombre-original].md`; ZIP: `[nombre-original]-md.zip`.

### Imágenes
- **MVP**: marcador en el texto, sin enlace roto: `*[Image 3: <alt o "no description">]*` y un
  aviso con el número de imágenes omitidas.
- **Fase 2**: opción «Include images (ZIP)». Si está activa, el `.md` usa
  `![alt](images/image-003.png)` y se descarga un ZIP con el `.md` y la carpeta `images/`.

## Lector

- Vistas: Preview · Source · Split. Copiar, descargar `.md`, abrir un `.md` local.
- `marked` → **siempre** `DOMPurify.sanitize()` antes de insertar (el HTML de origen y el
  Markdown pueden traer `<script>`, `on*=` o `javascript:`). Es el único `innerHTML` permitido.
- Índice generado a partir de h1–h3, con anclas estables.
- Enlaces del documento con `rel="noopener noreferrer"` y `target="_blank"`.

## HTML

- Textos de interfaz en **inglés**. Comillas “”, separador `·`, flechas `↗ ↓ →`.
- `meta color-scheme="dark"`, `theme-color="#07090d"`, `preload` de las dos fuentes.
- Accesibilidad: `role="status" aria-live="polite"` en la línea de estado, `aria-label` en
  secciones, iconos SVG con `aria-hidden`. Los `<svg>` se ocultan con el atributo `hidden`
  (`toggleAttribute`), no con la propiedad `.hidden`.

## CSS

- Tokens: `--bg --surface --line --line-strong --fg --muted --accent --on-accent --danger
  --mono --pixel`, iguales a los hermanos salvo el acento.
- Acento por `:root[data-accent="amber"]` (`--accent: #f5a524; --on-accent: #07090d`).
  Alternativa para comparar: `:root[data-accent="violet"]` (`#8b6cff`, `--on-accent: #07090d`).
  `?accent=amber|violet` para comparar. No introducir colores sueltos: si hace falta uno nuevo,
  se añade como token.
- Estética: oscuro, `border-radius: 0`, bordes de 1px, etiquetas en mayúsculas 11px con
  `letter-spacing: .12em`, títulos en Geist Pixel, cuerpo 13px Geist Mono.
- El **contenido renderizado del lector** usa la misma Geist Mono pero con interlineado amplio
  (1.65), ancho de lectura ~72ch y estilos propios para tablas, citas, código y `hr`, todos
  con tokens.
- `max-width: 860px` (el lector en modo Split puede ocupar hasta 1200px), gutter 16px,
  breakpoint móvil 560px, `prefers-reduced-motion` respetado. `color-mix()` permitido.
- Huecos de anuncios futuros: no se maquetan todavía, pero el diseño no debe depender de que
  no existan (nada de alturas fijas que se rompan al insertar un bloque).

## JavaScript

- Vanilla, scripts clásicos. Helper `const $ = (id) => document.getElementById(id);`.
- **Rutas absolutas desde la raíz** (`/vendor/…`, `/converters/…`, `/workers/…`) en HTML y JS:
  las páginas por formato viven en subcarpetas y una ruta relativa se rompería allí.
- 2 espacios, comillas dobles, punto y coma, funciones flecha, plantillas literales.
- Estado en `let` de nivel superior; funciones pequeñas con nombre.
- Comentarios en español y solo para explicar el porqué.
- Nunca `innerHTML` con datos del usuario (nombres de archivo, texto extraído): `textContent`.
  Única excepción: el HTML del lector, ya pasado por DOMPurify.
- `localStorage` dentro de `try/catch` y solo para preferencias (vista del lector, front
  matter sí/no, acento).
- `URL.createObjectURL` siempre con su `revokeObjectURL`.
- Errores visibles en `#summary` y en la fila del archivo (`.err`), nunca solo en consola. Si
  falta soporte del navegador (DecompressionStream, workers de módulo), aviso claro.
- Tamaños con `fmt(bytes)`. Archivos > 100 MB: avisar antes de convertir.

## Páginas y SEO

- Páginas estáticas por formato (decisión del 2026-11-17): `tools/pages.mjs` toma `index.html`
  como plantilla y reescribe el bloque `<!-- seo -->` (title, description, canonical, Open
  Graph), el bloque `<!-- page -->` (H1 + párrafo `.intro`), `#dropTitle`, el enlace a la portada,
  `aria-current` en el pie y `data-format` en `<html>`. Genera también `404.html` (noindex; sin
  ella Cloudflare Pages serviría `index.html` con 200 en cualquier URL) y `sitemap.xml`.
- **Cada cambio en `index.html` exige `node tools/pages.mjs`**; `node tools/pages.mjs --check`
  falla si algo está desactualizado. Los textos de cada página (únicos, en inglés) y `LASTMOD`
  viven en el propio script.
- Variantes agrupadas para no crear páginas casi idénticas: DOCX cubre DOCM, PPTX cubre
  PPSX/PPTM, PPT cubre PPS, ABW cubre ZABW. WPD, LWP y Works tienen página que explica la
  alternativa. `/markdown-viewer/` presenta el lector.
- `data-format` preselecciona el formato «blando» (`softFormat` en `app.js`): si se suelta un
  archivo de otro formato reconocible se usa el detectado; si el usuario cambia el selector, manda
  su elección.
- Imágenes Open Graph: con el servidor local en marcha, capturar `/tools/og.html?name=<Nombre>`
  (o `?viewer`) a 1200×630 y guardarla como `og/<slug>.png`. Se rehacen solo si cambia el diseño o
  se añade una página.
- Novedades: bloque `<details class="changelog">` en el pie de `index.html`. Cada versión añade un
  `<li>` arriba y actualiza el `<summary>`; luego regenerar las páginas.
- `robots.txt` propio (Cloudflare antepone sus reglas gestionadas si están activas en la zona).
  `test.html` y `/tools/` van con `noindex`.
- Revisión del 2026-11-17 (Lighthouse 13.6, móvil simulado): rendimiento 98, accesibilidad,
  buenas prácticas y SEO 100. Contraste AA en todos los pares de tokens (violeta incluido); foco
  visible en todos los elementos al navegar con Tab.

## Cabeceras (`_headers`)

- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
  connect-src 'self' https://assets.ferguedez.dev; img-src 'self' data: blob:;
  style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
  Revisar si alguna librería necesita algo más; nunca añadir `'unsafe-eval'`.
- Una regla por extensión; un solo `*` por patrón; nunca dos `Cache-Control` para la misma URL.
- `.wasm` local (si lo hubiera) con `Content-Type: application/wasm`.

## Pruebas

- `_test/` (ignorado en git) contiene archivos reales de cada formato y, junto a cada uno, el
  `.md` esperado (`informe.pdf` → `informe.expected.md`).
- `_test/dev/` es un juego sintético (generado, no son archivos reales) que se abre con
  `test.html?set=dev`; `?run` lo lanza al cargar. `_test/dev/legacy/` son archivos de prueba de Apache POI
  (licencia Apache-2.0, `LICENSE-poi-test-data.txt`): DOC y PPT reales, cifrados, Word 6 y fuzzing.
- `test.html` carga la lista de `_test/manifest.json`, convierte cada archivo con el mismo
  código que la app y muestra una tabla con OK/diferencias (diff por líneas). Se abre en local
  con un servidor estático (`python3 -m http.server`).
- Antes de cerrar cualquier cambio en un conversor, pasar `test.html` completo: un cambio en
  `postprocess.js` afecta a todos.

## Git y despliegue

- Mensajes de commit en español, breves y descriptivos.
- Despliegue: **Worker de assets estáticos** (no Pages) conectado a GitHub con Workers Builds,
  rama `main`. `wrangler.jsonc` sirve la raíz del repo y usa `404.html` para las URL
  inexistentes; `.assetsignore` excluye lo interno (`.claude/`, `tools/`, `_test/`,
  `.gitignore`, `wrangler.jsonc`). Sin comando de build. Dominio: `md.ferguedez.dev`.
- Un push a `main` publica en producción: confirmar siempre antes de hacerlo.
