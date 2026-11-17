// DOCX/DOCM: mammoth → HTML → turndown (htmlToMarkdown de html.js).
// mammoth localiza el documento por las relaciones del paquete, así que DOCM funciona igual;
// las macros (vbaProject.bin) nunca se leen.
const MAMMOTH = "vendor/mammoth-1.13.0.browser.min.js";

// Se suman al mapa de estilos por defecto de mammoth (Heading 1…6 ya vienen incluidos).
const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "r[style-name='HTML Code'] => code",
];

// El título de las propiedades del documento (docProps/core.xml), para el front matter.
async function officeTitle(bytes) {
  const xml = await readZipText(bytes, "docProps/core.xml");
  if (!xml) return "";
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const el = doc.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")[0];
  return el ? el.textContent.trim() : "";
}

registerConverter({
  id: "docx",
  label: "Word (DOCX)",
  extensions: ["docx", "docm"],
  load: () => Promise.all([loadScript(MAMMOTH), loadScript("converters/html.js").then(() => loadTurndown())]),
  convert: async (buffer, opts, ctx) => {
    ctx.progress(0.05);
    // Cada imagen se queda como «md-image:N»; sus bytes solo se leen si van al ZIP.
    const found = [];
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
      styleMap: DOCX_STYLE_MAP,
      convertImage: mammoth.images.imgElement(async (image) => {
        // El hueco se reserva antes del await: mammoth puede resolver varias imágenes a la vez.
        const n = found.push(null) - 1;
        if (opts.includeImages) found[n] = { data: await image.readAsArrayBuffer(), ext: imageExt(image.contentType), key: `img${n}` };
        return { src: `md-image:${n}` };
      }),
    });
    ctx.signal?.throwIfAborted();
    ctx.progress(0.7);
    const resolveImage = (src) => (/^md-image:\d+$/.test(src) ? found[+src.slice(9)] : null);
    const out = htmlToMarkdown(result.value, { includeImages: opts.includeImages, resolveImage });
    if (result.messages.some((m) => m.type === "error")) out.warnings.push("Some parts of the document couldn't be read");
    out.title = await officeTitle(new Uint8Array(buffer));
    ctx.progress(1);
    return out;
  },
});
