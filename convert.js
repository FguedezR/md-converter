// Registro de conversores y orquestación de una conversión (sin UI).
// Lo comparten app.js y test.html para que las pruebas usen exactamente el mismo código.

const converters = [];

// Cada formato con conversor apunta al script que lo registra; se carga solo cuando hace falta.
const CONVERTER_SCRIPTS = {
  txt: "converters/txt.js",
  html: "converters/html.js",
  docx: "converters/docx.js",
  docm: "converters/docx.js",
  pdf: "converters/pdf.js",
  pptx: "converters/pptx.js",
  ppsx: "converters/pptx.js",
  pptm: "converters/pptx.js",
  odt: "converters/odf.js",
  odp: "converters/odf.js",
  abw: "converters/abw.js",
  zabw: "converters/abw.js",
  rtf: "converters/pandoc.js",
  rst: "converters/pandoc.js",
  tex: "converters/pandoc.js",
  doc: "converters/ole.js",
  ppt: "converters/ole.js",
  pps: "converters/ole.js",
  wps: "converters/ole.js",
  dps: "converters/ole.js",
};

// Formatos que admiten «Include images (ZIP)».
const IMAGE_FORMATS = ["docx", "docm", "pptx", "ppsx", "pptm", "odt", "odp", "pdf"];

const JSZIP_SRC = "vendor/jszip-3.10.2.min.js";

function registerConverter(converter) {
  if (converters.some((c) => c.id === converter.id)) return;
  converters.push(converter);
}

// Carga una librería o un conversor solo la primera vez que hace falta.
const scriptCache = {};
function loadScript(src) {
  return (scriptCache[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete scriptCache[src]; reject(new Error(`Couldn't load ${src}. Check your connection and try again.`)); };
    document.head.appendChild(s);
  }));
}

// «ready» | «reader» (.md) | «soon» (sin conversor todavía) | «unsupported» | «unknown»
function formatStatus(format) {
  if (format === "md") return "reader";
  const info = FORMATS[format];
  if (!info) return "unknown";
  if (info.unsupported) return "unsupported";
  return CONVERTER_SCRIPTS[format] ? "ready" : "soon";
}

function statusMessage(format) {
  const status = formatStatus(format);
  if (status === "unsupported") return UNSUPPORTED_MESSAGE;
  if (status === "soon") return FORMATS[format].textOnly ? "Coming soon (text only)" : "Coming soon";
  if (status === "unknown") return "Unrecognized format. Pick the source format manually if you know it.";
  return "";
}

async function getConverter(format) {
  const src = CONVERTER_SCRIPTS[format];
  if (!src) throw new Error(statusMessage(format));
  await loadScript(src);
  const converter = converters.find((c) => c.extensions.includes(format));
  if (!converter) throw new Error(`No converter registered for ${format}`);
  if (converter.load) await converter.load();
  return converter;
}

// Devuelve la salida cruda del conversor; finalizeMarkdown() la normaliza aparte para que
// cambiar el front matter no obligue a reconvertir.
async function convertDocument(buffer, format, opts = {}, { signal, onProgress, onStatus, confirm } = {}) {
  const converter = await getConverter(format);
  signal?.throwIfAborted();
  // confirm(): pide permiso antes de algo costoso (la descarga de pandoc); status(): texto de la fila.
  const ctx = {
    signal,
    progress: (p) => onProgress?.(Math.max(0, Math.min(1, p))),
    status: (text) => onStatus?.(text),
    confirm: (message) => (confirm ? confirm(message) : Promise.resolve(true)),
  };
  opts = { ...opts, sourceFormat: format, includeImages: !!opts.includeImages && IMAGE_FORMATS.includes(format) };
  const result = await converter.convert(buffer, opts, ctx);
  signal?.throwIfAborted();
  return { markdown: result.markdown || "", warnings: [...new Set(result.warnings || [])], images: result.images || [], title: result.title || "" };
}

const finalizeMarkdown = (result, name, opts = {}) =>
  normalizeMarkdown(result.markdown, { frontMatter: !!opts.frontMatter, title: result.title, source: name, date: opts.date });
