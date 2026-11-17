// Detección de formato por firma de bytes; la extensión solo desempata.
// Funciones puras (sin DOM): las usan la app y test.html.

const FORMATS = {
  pdf: { label: "PDF" },
  docx: { label: "Word (DOCX)" },
  docm: { label: "Word with macros (DOCM)" },
  pptx: { label: "PowerPoint (PPTX)" },
  ppsx: { label: "PowerPoint Show (PPSX)" },
  pptm: { label: "PowerPoint with macros (PPTM)" },
  odt: { label: "OpenDocument Text (ODT)" },
  odp: { label: "OpenDocument Presentation (ODP)" },
  abw: { label: "AbiWord (ABW)" },
  zabw: { label: "AbiWord compressed (ZABW)" },
  rtf: { label: "Rich Text (RTF)" },
  rst: { label: "reStructuredText (RST)" },
  tex: { label: "LaTeX (TEX)" },
  html: { label: "HTML" },
  txt: { label: "Plain text (TXT)" },
  md: { label: "Markdown" },
  doc: { label: "Word 97–2003 (DOC)", textOnly: true },
  ppt: { label: "PowerPoint 97–2003 (PPT)", textOnly: true },
  pps: { label: "PowerPoint Show 97–2003 (PPS)", textOnly: true },
  wps: { label: "Kingsoft Writer (WPS)", textOnly: true },
  dps: { label: "Kingsoft Presentation (DPS)", textOnly: true },
  works: { label: "Microsoft Works (WPS)", unsupported: true },
  wpd: { label: "WordPerfect (WPD)", unsupported: true },
  lwp: { label: "Lotus Word Pro (LWP)", unsupported: true },
};

const UNSUPPORTED_MESSAGE = "This format can't be converted in the browser. Save it as DOCX in your word processor and convert that file.";

const EXTENSION_FORMATS = {
  pdf: "pdf", docx: "docx", docm: "docm", dotx: "docx", pptx: "pptx", ppsx: "ppsx", pptm: "pptm",
  odt: "odt", odp: "odp", abw: "abw", zabw: "zabw", rtf: "rtf", rst: "rst", rest: "rst",
  tex: "tex", latex: "tex", ltx: "tex", html: "html", htm: "html", xhtml: "html",
  txt: "txt", text: "txt", md: "md", markdown: "md", doc: "doc", ppt: "ppt", pps: "pps",
  wps: "wps", dps: "dps", wpd: "wpd", lwp: "lwp",
};

const ZIP_CONTENT_TYPES = [
  ["application/vnd.ms-word.document.macroEnabled.main+xml", "docm"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "docx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml", "docx"],
  ["application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml", "pptm"],
  ["application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml", "pptm"],
  ["application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml", "ppsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "pptx"],
];

const extensionOf = (name) => (/\.([^.\\/]+)$/.exec(name || "") || ["", ""])[1].toLowerCase();

const startsWith = (bytes, sig, at = 0) => sig.every((b, i) => bytes[at + i] === b);

// Latin-1 conserva cada byte como un carácter: sirve para buscar firmas ASCII sin decodificar.
const asciiHead = (bytes, n = 4096) => String.fromCharCode(...bytes.subarray(0, Math.min(n, bytes.length)));

async function detectFormat(bytes, name) {
  const ext = extensionOf(name);
  const byExt = EXTENSION_FORMATS[ext] || null;
  const found = (format) => ({ format, by: "signature" });

  if (asciiHead(bytes, 1024).includes("%PDF-")) return found("pdf");
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = await detectZip(bytes);
    return zip ? found(zip) : { format: byExt || "unknown", by: "extension" };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const ole = detectOle(bytes, ext);
    return ole ? found(ole) : { format: "unknown", by: "signature" };
  }
  if (startsWith(bytes, [0xff, 0x57, 0x50, 0x43])) return found("wpd");
  if (startsWith(bytes, [0x1f, 0x8b])) {
    const head = await inflateHead(bytes, "gzip");
    if (head && /<abiword[\s>]/i.test(head)) return found("zabw");
    return { format: byExt === "zabw" ? "zabw" : "unknown", by: "extension" };
  }

  const head = asciiHead(bytes).replace(/^(\xef\xbb\xbf|\xff\xfe|\xfe\xff)/, "");
  const lead = head.trimStart().toLowerCase();
  if (lead.startsWith("{\\rtf")) return found("rtf");
  if (lead.startsWith("<abiword") || (lead.startsWith("<?xml") && /<abiword[\s>]/i.test(head))) return found("abw");
  if (head.startsWith("WordPro")) return found("lwp");
  if (/^(<!--[\s\S]*?-->\s*)*(<!doctype html|<html[\s>])/.test(lead) || (lead.startsWith("<?xml") && /<html[\s>]/i.test(head))) return found("html");
  if (/\\documentclass|\\begin\{document\}/.test(head)) return found("tex");

  if (byExt) return { format: byExt, by: "extension" };
  // Sin extensión conocida: si no hay bytes nulos, lo tratamos como texto plano.
  if (!bytes.subarray(0, 4096).includes(0)) return { format: "txt", by: "content" };
  return { format: "unknown", by: "signature" };
}

/* ---------- ZIP (OOXML y OpenDocument) ---------- */

async function detectZip(bytes) {
  const entries = listZipEntries(bytes);
  if (!entries) return null;
  // ODF guarda «mimetype» sin comprimir y en primer lugar, pero no siempre se respeta.
  if (entries.has("mimetype")) {
    const mime = (await readZipText(bytes, "mimetype", entries)) || "";
    if (mime.startsWith("application/vnd.oasis.opendocument.text")) return "odt";
    if (mime.startsWith("application/vnd.oasis.opendocument.presentation")) return "odp";
  }
  if (entries.has("[Content_Types].xml")) {
    const types = (await readZipText(bytes, "[Content_Types].xml", entries)) || "";
    const hit = ZIP_CONTENT_TYPES.find(([type]) => types.includes(type));
    if (hit) return hit[1];
  }
  return null;
}

// Lee el directorio central del ZIP: nombre → { method, size, offset }. Sin soporte ZIP64.
function listZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(p + 28, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, {
      method: view.getUint16(p + 10, true),
      compSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return entries;
}

async function readZipEntry(bytes, name, entries = listZipEntries(bytes)) {
  const e = entries && entries.get(name);
  if (!e) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(e.offset, true) !== 0x04034b50) return null;
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const data = bytes.subarray(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflate(data, "deflate-raw");
  return null;
}

async function readZipText(bytes, name, entries) {
  const data = await readZipEntry(bytes, name, entries);
  return data ? new TextDecoder().decode(data) : null;
}

async function inflate(data, format) {
  if (typeof DecompressionStream === "undefined") return null;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Descomprime solo el principio: basta para reconocer la cabecera sin inflar todo el archivo.
async function inflateHead(bytes, format, max = 4096) {
  if (typeof DecompressionStream === "undefined") return null;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  let out = "";
  try {
    while (out.length < max) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
  } catch (e) {
    return out || null;
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

/* ---------- OLE / CFB (formatos binarios antiguos) ---------- */

// Recorre la cadena del directorio del CFB y devuelve los nombres de los streams.
// Buscar los nombres «a pelo» en los bytes daría falsos positivos con el texto UTF-16 del documento.
function oleStreamNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  if (sectorSize !== 512 && sectorSize !== 4096) return [];
  const perSector = sectorSize / 4;
  const sectorOffset = (n) => (n + 1) * sectorSize;
  const END = 0xfffffffe;

  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = view.getUint32(0x4c + i * 4, true);
    if (s >= 0xfffffffa) break;
    fatSectors.push(s);
  }
  let difat = view.getUint32(0x44, true);
  for (let guard = 0; difat < END && guard < 10000; guard++) {
    const base = sectorOffset(difat);
    if (base + sectorSize > bytes.length) break;
    for (let i = 0; i < perSector - 1; i++) {
      const s = view.getUint32(base + i * 4, true);
      if (s < 0xfffffffa) fatSectors.push(s);
    }
    difat = view.getUint32(base + (perSector - 1) * 4, true);
  }
  const nextSector = (n) => {
    const fat = fatSectors[Math.floor(n / perSector)];
    if (fat === undefined) return END;
    const at = sectorOffset(fat) + (n % perSector) * 4;
    return at + 4 <= bytes.length ? view.getUint32(at, true) : END;
  };

  const names = [];
  let sector = view.getUint32(0x30, true);
  for (let guard = 0; sector < 0xfffffffa && guard < 100000; guard++) {
    const base = sectorOffset(sector);
    if (base + sectorSize > bytes.length) break;
    for (let off = base; off < base + sectorSize; off += 128) {
      const len = view.getUint16(off + 0x40, true);
      if (len < 2 || len > 64) continue;
      let name = "";
      for (let i = 0; i < len - 2; i += 2) name += String.fromCharCode(view.getUint16(off + i, true));
      names.push(name);
    }
    sector = nextSector(sector);
  }
  return names;
}

function detectOle(bytes, ext) {
  const names = oleStreamNames(bytes);
  if (names.includes("WordDocument")) return ext === "wps" ? "wps" : "doc";
  if (names.includes("PowerPoint Document")) return ext === "dps" ? "dps" : ext === "pps" ? "pps" : "ppt";
  if (names.includes("MN0") || names.includes("CONTENTS")) return "works";
  return null;
}

/* ---------- Texto ---------- */

// Decodifica texto respetando BOM; si no es UTF-8 válido, cae a Windows-1252 y lo indica.
function decodeText(bytes, declared) {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  if (startsWith(bytes, [0xff, 0xfe])) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (startsWith(bytes, [0xfe, 0xff])) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  if (declared) {
    try { return { text: new TextDecoder(declared).decode(bytes), encoding: declared.toLowerCase() }; } catch (e) {}
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch (e) {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}
