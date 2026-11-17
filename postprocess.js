// Normalización común de toda salida Markdown y utilidades para los conversores.
// Funciones puras (sin DOM).

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^#{1,6}(\s|$)/;

function normalizeMarkdown(md, opts = {}) {
  const lines = String(md).replace(/\r\n?/g, "\n").replace(/[​﻿]/g, "").split("\n");
  const out = [];
  let fence = null;
  let blankAfter = false;
  const blank = () => { if (out.length && out[out.length - 1] !== "") out.push(""); };

  lines.forEach((raw, i) => {
    if (fence) {
      out.push(raw.replace(/\s+$/, ""));
      const close = FENCE.exec(raw);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !raw.trim().slice(close[1].length)) {
        fence = null;
        blankAfter = true;
      }
      return;
    }
    // Salto duro con dos espacios → barra invertida: los espacios finales están prohibidos.
    const next = lines[i + 1];
    let line = /\S( {2,}|\t)$/.test(raw) && next !== undefined && next.trim() && !ATX.test(raw) ? raw.replace(/\s+$/, "\\") : raw.replace(/\s+$/, "");
    if (!line) { blank(); blankAfter = false; return; }
    if (blankAfter) { blank(); blankAfter = false; }
    const open = FENCE.exec(line);
    if (open) {
      blank();
      fence = open[1];
    } else if (ATX.test(line)) {
      blank();
      blankAfter = true;
    }
    out.push(line);
  });
  if (fence) out.push(fence);

  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  const body = out.join("\n");
  const front = opts.frontMatter ? frontMatter(opts, body) : "";
  return front + body + "\n";
}

function frontMatter(opts, body) {
  const firstH1 = /^# (.+)$/m.exec(body);
  const title = (opts.title || "").trim() || (firstH1 ? firstH1[1].trim() : "") || baseName(opts.source || "");
  const converted = opts.date || new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const lines = ["---", `title: ${JSON.stringify(title)}`];
  if (opts.source) lines.push(`source: ${JSON.stringify(opts.source)}`);
  lines.push(`converted: ${converted}`, "---", "", "");
  return lines.join("\n");
}

const baseName = (name) => String(name).replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");

const outputName = (name) => `${baseName(name) || "document"}.md`;

// Escapa texto plano (PDF, presentaciones) para que no se interprete como Markdown.
function escapeMarkdown(text) {
  return String(text)
    .replace(/[\\`*_[\]<>|]/g, "\\$&")
    .replace(/^(\s*)(#{1,6}\s|[-+=]\s|>|~~~|(\d+)([.)])\s)/, (m, sp, mark, _, digits, dot) =>
      digits ? `${sp}${digits}\\${dot} ` : `${sp}\\${mark}`);
}

// Tabla GFM a partir de filas de celdas ya convertidas a Markdown en línea; la primera fila es la cabecera.
function markdownTable(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (s) => String(s || "").replace(/\n+/g, "<br>").replace(/(?<!\\)\|/g, "\\|").trim();
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

// Marcador del MVP para imágenes omitidas: sin enlace roto.
function imagePlaceholder(n, alt) {
  const text = String(alt || "").replace(/\s+/g, " ").trim() || "no description";
  return `*[Image ${n}: ${text.replace(/[\\*_[\]]/g, "\\$&")}]*`;
}

const imagesWarning = (n) => `${n} ${n === 1 ? "image" : "images"} omitted`;

const MERGED_WARNING = "Tables with merged cells were flattened";

// El HTML ajeno se analiza con DOMParser, que hereda la CSP de la página: cada style= u on*=
// deja un aviso en consola aunque nunca llegue a ejecutarse. Se renombran antes de analizar.
function neutralizeInlineHtml(html) {
  return String(html)
    .replace(/<(\/?)style(?=[\s>/])/gi, "<$1md-style")
    .replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(/(\s)(on[a-z]+|style)(\s*=)/gi, "$1data-md-$2$3"));
}

/* ---------- Texto con formato (presentaciones, ODF, AbiWord) ---------- */

// segments: [{ text, b, i, href, raw, br }]. «raw» va sin escapar (notas al pie, imágenes);
// «br» es un salto de línea duro. Se unen los trozos con el mismo formato para no generar «**a****b**».
function renderInline(segments) {
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    const plain = !s.raw && !s.br;
    if (last && plain && !last.raw && !last.br && !!last.b === !!s.b && !!last.i === !!s.i && (last.href || "") === (s.href || "")) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged.map((s) => {
    if (s.br) return "\\\n";
    if (s.raw) return s.raw;
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text.replace(/\s+/g, " "));
    if (!core) return s.text.replace(/\s+/g, " ");
    let md = escapeMarkdown(core);
    if (s.i) md = `*${md}*`;
    if (s.b) md = `**${md}**`;
    if (s.href) md = `[${md}](${s.href.replace(/[()\s]/g, encodeURIComponent)})`;
    return lead + md + trail;
  }).join("").replace(/ *\\\n */g, "\\\n").trim();
}

/* ---------- Imágenes ---------- */

const IMAGE_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/bmp": "bmp",
  "image/tiff": "tif", "image/webp": "webp", "image/svg+xml": "svg", "image/x-emf": "emf",
  "image/emf": "emf", "image/x-wmf": "wmf", "image/wmf": "wmf",
};
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", svg: "image/svg+xml", emf: "image/emf", wmf: "image/wmf" };

const imageExt = (mime, path = "") =>
  IMAGE_EXT[String(mime || "").toLowerCase()] || ((/\.([a-z0-9]{2,4})$/i.exec(path) || [])[1] || "bin").toLowerCase().replace("jpeg", "jpg");

const imageFileName = (n, ext) => `image-${String(n).padStart(3, "0")}.${ext}`;

const imageLink = (name, alt) => `![${String(alt || "").replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, "\\$&")}](images/${name})`;

// Numera las imágenes de un documento. Con include, las que traen datos se guardan como
// images/image-NNN.ext y se enlazan; el resto (o todas, sin include) quedan como marcador.
// «key» evita duplicar la misma imagen usada varias veces.
function createImageSink(include) {
  const images = [];
  const byKey = new Map();
  let count = 0;
  let omitted = 0;
  return {
    images,
    add(alt, data, ext, key) {
      if (include && data && key && byKey.has(key)) return imageLink(byKey.get(key), alt);
      count++;
      if (include && data) {
        const name = imageFileName(count, ext || "bin");
        images.push({ name, blob: data instanceof Blob ? data : new Blob([data], { type: IMAGE_MIME[ext] || "application/octet-stream" }), alt: alt || "" });
        if (key) byKey.set(key, name);
        return imageLink(name, alt);
      }
      omitted++;
      return imagePlaceholder(count, alt);
    },
    warnings: () => (omitted ? [imagesWarning(omitted)] : []),
  };
}
