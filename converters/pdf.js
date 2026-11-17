// PDF: pdf.js extrae el texto con posiciones y aquí se reconstruye la estructura:
// títulos por tamaño de fuente, párrafos unidos, guiones de corte y cabeceras/pies repetidos.
const PDFJS_DIR = "/vendor/pdfjs-6.5.438/";
const pdfAsset = (file) => new URL(PDFJS_DIR + file, location.href).href;
let pdfjsLib = null;

const SCANNED_WARNING = "This PDF looks scanned: it has no text layer to extract. Convert it again and choose Download to recognise the text with OCR.";
const MIN_PAGE_CHARS = 5;
const MIN_IMAGE_PT = 24; // por debajo son iconos o adornos, no imágenes de contenido
const BULLET = /^([•●○◦▪■□‣⁃∙·\-–—*])\s+(.*)$/;
const ORDERED = /^(\d{1,3})[.)]\s+(.*)$/;
const PAGE_NUMBER = /^(page\s+|p\.\s*|página\s+)?\d{1,4}(\s*(\/|of|de)\s*\d{1,4})?$/i;

async function loadPdfjs() {
  if (pdfjsLib) return;
  // pdf.js solo se publica como ES module: único caso de import() dinámico.
  const lib = await import(pdfAsset("pdf.min.mjs"));
  lib.GlobalWorkerOptions.workerSrc = pdfAsset("pdf.worker.min.mjs");
  pdfjsLib = lib;
}

/* ---------- Enlaces ---------- */

// El texto enlazado queda entre marcadores de uso privado, con el número del enlace codificado en
// un segundo carácter: así sobrevive a la unión de líneas y párrafos y se convierte al final.
const LINK_OPEN = "\uE000";
const LINK_CLOSE = "\uE001";
const LINK_BASE = 0xe100;

// Rectángulos de una anotación de enlace. Si ocupa varias líneas, QuadPoints trae uno por línea;
// el `rect` general las engloba todas y cogería texto que no está enlazado.
function linkRects(a) {
  const q = a.quadPoints;
  if (!q || q.length < 8) return [a.rect];
  const rects = [];
  for (let i = 0; i + 8 <= q.length; i += 8) {
    const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
    const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return rects;
}

// El centro del trozo de texto tiene que caer dentro de alguno de los rectángulos del enlace.
function linkAt(links, x, y, width, size) {
  const cx = x + width / 2;
  const cy = y + size * 0.3;
  return links.find(({ rects }) => rects.some(([x1, y1, x2, y2]) => cx >= x1 - 1 && cx <= x2 + 1 && cy >= y1 - 1 && cy <= y2 + 1));
}

function linkify(md, hrefs) {
  // Un enlace partido en dos líneas deja dos tramos seguidos con el mismo número: se unen.
  let merged = md;
  for (let prev = ""; prev !== merged;) {
    prev = merged;
    merged = merged.replace(/\uE000([\uE100-\uF8FF])([^\uE001]*)\uE001(\s*)\uE000\1/g, "\uE000$1$2$3");
  }
  return merged
    .replace(/\uE000([\uE100-\uF8FF])([\s\S]*?)\uE001/g, (m, code, inner) => {
      const href = hrefs[code.charCodeAt(0) - LINK_BASE];
      return href && inner.trim() ? `[${inner}](${href.replace(/[()\s]/g, encodeURIComponent)})` : inner;
    })
    .replace(/[\uE000\uE001]|(?<=\uE000)[\uE100-\uF8FF]/g, "");
}

/* ---------- Líneas de una página ---------- */

function pageLines(items, page, links = []) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 1;
    if (!it.str.trim()) {
      if (cur && it.str) cur.space = true;
      if (cur && it.hasEOL) cur.eol = true;
      continue;
    }
    const newLine = !cur || cur.eol || Math.abs(y - cur.y) > Math.max(size, cur.size) * 0.5 || x < cur.xEnd - size;
    if (newLine) {
      if (cur && cur.link >= 0) cur.text += LINK_CLOSE;
      cur = { page, x, y, xEnd: x, size, text: "", chars: new Map(), space: false, eol: false, link: -1 };
      lines.push(cur);
    } else if ((cur.space || x - cur.xEnd > size * 0.2) && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) {
      cur.text += " ";
    }
    const link = links.length ? (linkAt(links, x, y, it.width, size)?.idx ?? -1) : -1;
    if (link !== cur.link) {
      if (cur.link >= 0) cur.text += LINK_CLOSE;
      if (link >= 0) cur.text += LINK_OPEN + String.fromCharCode(LINK_BASE + link);
      cur.link = link;
    }
    cur.text += it.str;
    cur.xEnd = Math.max(cur.xEnd, x + it.width);
    cur.space = false;
    cur.eol = !!it.hasEOL;
    // El tamaño de la línea es el que tienen más caracteres (un superíndice no cuenta).
    const key = Math.round(size * 2) / 2;
    cur.chars.set(key, (cur.chars.get(key) || 0) + it.str.length);
  }
  if (cur && cur.link >= 0) cur.text += LINK_CLOSE;
  for (const l of lines) {
    l.text = l.text.replace(/\s+/g, " ").trim();
    l.size = [...l.chars].sort((p, q) => q[1] - p[1])[0][0];
  }
  return lines.filter((l) => l.text);
}

// Posiciones (parte superior, en puntos) de las imágenes pintadas en la página.
function pageImages(opList, OPS) {
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const images = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  opList.fnArray.forEach((fn, i) => {
    const args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args && args[0];
      if (m && m.length === 6) ctm = mul(ctm, [...m]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      if (w >= MIN_IMAGE_PT && h >= MIN_IMAGE_PT) {
        const ref = fn === OPS.paintInlineImageXObject ? { inline: args[0] } : { id: args[0] };
        images.push({ ...ref, y: Math.max(ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]) });
      }
    }
  });
  return images;
}

// Convierte una imagen ya decodificada por pdf.js en PNG. Llega como ImageBitmap o como píxeles
// (RGBA, RGB o 1 bit por píxel, con las filas rellenadas hasta el byte).
async function imageToPng(page, ref) {
  const img = ref.inline || (ref.id.startsWith("g_") ? page.commonObjs : page.objs).get(ref.id);
  if (!img || !img.width || !img.height) return null;
  const canvas = new OffscreenCanvas(img.width, img.height);
  const c2d = canvas.getContext("2d");
  if (img.bitmap) {
    c2d.drawImage(img.bitmap, 0, 0);
  } else if (img.data) {
    const { width: w, height: h, data, kind } = img;
    let rgba = data;
    if (kind === pdfjsLib.ImageKind.RGB_24BPP) {
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < w * h; i++, j += 3) rgba.set([data[j], data[j + 1], data[j + 2], 255], i * 4);
    } else if (kind === pdfjsLib.ImageKind.GRAYSCALE_1BPP) {
      rgba = new Uint8ClampedArray(w * h * 4);
      const rowBytes = (w + 7) >> 3;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = data[y * rowBytes + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
          rgba.set([v, v, v, 255], (y * w + x) * 4);
        }
      }
    }
    c2d.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  } else {
    return null;
  }
  return canvas.convertToBlob({ type: "image/png" });
}

/* ---------- Cabeceras y pies repetidos ---------- */

function removeRunningLines(pages) {
  const band = (line, height) => line.y > height * 0.88 || line.y < height * 0.12;
  const key = (text) => text.replace(/\d+/g, "#").toLowerCase();
  const counts = new Map();
  for (const p of pages) {
    for (const k of new Set(p.lines.filter((l) => band(l, p.height)).map((l) => key(l.text)))) counts.set(k, (counts.get(k) || 0) + 1);
  }
  // «En todas las páginas», con margen para una portada sin cabecera.
  const needed = pages.length >= 3 ? pages.length - 1 : pages.length;
  let removed = 0;
  for (const p of pages) {
    p.lines = p.lines.filter((l) => {
      if (!band(l, p.height)) return true;
      const repeated = pages.length >= 2 && counts.get(key(l.text)) >= needed;
      const pageNumber = pages.length >= 2 && PAGE_NUMBER.test(l.text);
      if (repeated || pageNumber) removed++;
      return !(repeated || pageNumber);
    });
  }
  return removed;
}

/* ---------- Estructura ---------- */

function headingLevels(pages) {
  const chars = new Map();
  let total = 0;
  for (const l of pages.flatMap((p) => p.lines)) {
    chars.set(l.size, (chars.get(l.size) || 0) + l.text.length);
    total += l.text.length;
  }
  const body = [...chars].sort((p, q) => q[1] - p[1])[0]?.[0] || 0;
  // Un tamaño que ocupa mucho texto no es de títulos aunque sea mayor que el cuerpo.
  const sizes = [...chars].filter(([size, n]) => size >= body * 1.18 && n < total * 0.2).map(([size]) => size).sort((p, q) => q - p);
  return { body, level: (size) => (sizes.includes(size) ? Math.min(6, sizes.indexOf(size) + 1) : 0) };
}

function joinText(prev, next) {
  if (/­$/.test(prev)) return prev.slice(0, -1) + next;
  if (/\p{L}[-‐]$/u.test(prev) && /^\p{Ll}/u.test(next)) return prev.slice(0, -1) + next;
  return `${prev} ${next}`;
}

function buildBlocks(pages, levels) {
  const blocks = [];
  // Interlineado típico del cuerpo: separa saltos de línea normales de cambios de párrafo.
  const gaps = [];
  for (const p of pages) {
    for (let i = 1; i < p.lines.length; i++) {
      const g = p.lines[i - 1].y - p.lines[i].y;
      if (g > 0 && p.lines[i].size === levels.body && p.lines[i - 1].size === levels.body) gaps.push(g);
    }
  }
  gaps.sort((p, q) => p - q);
  const leading = gaps[Math.floor(gaps.length / 2)] || levels.body * 1.2;

  for (const p of pages) {
    if (p.ocr) {
      blocks.push(...p.ocr);
      continue;
    }
    const right = p.lines.filter((l) => l.size === levels.body).map((l) => l.xEnd).sort((a, b) => a - b);
    const rightEdge = right[Math.floor(right.length * 0.9)] || 0;
    let prevLine = null;
    for (const item of p.items) {
      if (item.image) {
        blocks.push({ type: "image", blob: item.blob, key: item.id });
        prevLine = null;
        continue;
      }
      const line = item;
      const last = blocks[blocks.length - 1];
      const level = levels.level(line.size);
      const gap = prevLine ? prevLine.y - line.y : Infinity;
      const close = prevLine && gap > 0 && gap <= leading * 1.45 && Math.abs(line.size - prevLine.size) < 1;
      const prevShort = prevLine && rightEdge && prevLine.xEnd < rightEdge * 0.8;

      if (level && line.text.length <= 200) {
        if (last && last.type === "heading" && last.level === level && close) last.text = joinText(last.text, line.text);
        else blocks.push({ type: "heading", level, text: line.text });
      } else {
        const bullet = BULLET.exec(line.text);
        const ordered = !bullet && ORDERED.exec(line.text);
        if (bullet || ordered) {
          blocks.push({ type: "item", number: ordered ? +ordered[1] : 0, x: line.x, text: (bullet || ordered)[2] });
        } else if (last && last.type === "item" && close && line.x > last.x + 2) {
          last.text = joinText(last.text, line.text);
        } else if (last && last.type === "para" && close && !prevShort) {
          last.text = joinText(last.text, line.text);
        } else if (last && last.type === "para" && !prevLine && !/[.!?:;"”»)]$/.test(last.text) && /^\p{Ll}/u.test(line.text)) {
          // Párrafo partido por un salto de página.
          last.text = joinText(last.text, line.text);
        } else {
          blocks.push({ type: "para", text: line.text });
        }
      }
      prevLine = line;
    }
  }
  return blocks;
}

function renderBlocks(blocks, sink, hrefs = []) {
  const out = [];
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    const sep = i === 0 ? "" : b.type === "item" && prev.type === "item" ? "\n" : "\n\n";
    let md;
    // Las listas numeradas conservan su número: entre párrafos, «1.» reiniciaría la cuenta.
    if (b.type === "heading") md = `${"#".repeat(b.level)} ${linkify(escapeMarkdown(b.text, false), hrefs)}`;
    else if (b.type === "item") md = `${b.number ? `${b.number}.` : "-"} ${linkify(escapeMarkdown(b.text), hrefs)}`;
    else if (b.type === "image") md = sink.add("", b.blob, "png", b.key);
    else md = linkify(escapeMarkdown(b.text), hrefs);
    out.push(sep + md);
  });
  return out.join("");
}

/* ---------- OCR ---------- */

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)] || 0;
};

// Rehace párrafos y títulos a partir de las líneas del OCR. Se mide la distancia entre los
// bordes superiores de líneas seguidas (las cajas se solapan por ascendentes y descendentes, así
// que el «hueco» no sirve): si supera claramente el interlineado típico, empieza otro párrafo.
// Una línea al menos un 30 % más alta que el cuerpo es un título.
function ocrBlocks(lines) {
  // Fuera la basura: líneas sin letras ni números o con muy poca confianza.
  const good = lines.filter((l) => /[\p{L}\p{N}]/u.test(l.text) && l.conf >= 30);
  if (!good.length) return [];
  const h = (l) => l.y1 - l.y0;
  const body = quantile(good.map(h), 0.5);
  const pitches = good.slice(1).map((l, i) => l.y0 - good[i].y0).filter((d) => d > 0 && d < body * 4);
  // Cuartil inferior: en un texto con muchos párrafos cortos, la mediana ya sería un salto de párrafo.
  const pitch = quantile(pitches, 0.25) || body * 1.4;
  const big = (l) => h(l) >= body * 1.3 && l.text.length <= 120;
  const sizeKey = (l) => Math.round((h(l) / body) * 4);
  const headingSizes = [...new Set(good.filter(big).map(sizeKey))].sort((a, b) => b - a);
  const level = (l) => (big(l) ? Math.min(3, headingSizes.indexOf(sizeKey(l)) + 1) : 0);

  const blocks = [];
  good.forEach((l, i) => {
    const prev = good[i - 1];
    const last = blocks[blocks.length - 1];
    const lv = level(l);
    const step = prev ? l.y0 - prev.y0 : Infinity;
    const joined = last && (last.level || 0) === lv && step > 0 && step <= Math.max(pitch, h(prev)) * 1.3;
    if (joined) last.text = joinText(last.text, l.text);
    else blocks.push(lv ? { type: "heading", level: lv, text: l.text } : { type: "para", text: l.text });
  });
  return blocks;
}

async function renderForOcr(page) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(4, 2400 / Math.max(base.width, base.height)) });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, viewport, background: "#ffffff" }).promise;
  const blob = await canvas.convertToBlob({ type: "image/png" });
  page.cleanup();
  return blob;
}

// Si hay páginas sin capa de texto, ofrece OCR (con aviso del tamaño de la descarga). Las páginas
// reconocidas quedan con p.ocr = [párrafos] y dejan de contar como vacías.
async function ocrScannedPages(doc, pages, opts, ctx) {
  const scanned = pages.filter((p) => p.empty);
  if (!scanned.length || opts.ocr === false) return { used: false, warnings: [] };
  const lang = OCR_LANGS[opts.ocrLang] ? opts.ocrLang : "eng";
  await loadScript("/converters/ocr.js");
  const what = scanned.length === pages.length ? "This PDF looks scanned" : `${scanned.length} of ${pages.length} pages look scanned`;
  ctx.status("Waiting for you to allow OCR…");
  const ok = await ctx.confirm(`${what}: there’s no text layer to extract. Recognise the text with OCR in ${OCR_LANGS[lang].label}? The first time it downloads about ${ocrDownloadMB(lang)} MB, and each page takes a few seconds. The OCR language can be changed in the options.`);
  if (!ok) return { used: false, warnings: [] };
  try {
    const images = [];
    for (const p of scanned) {
      ctx.signal?.throwIfAborted();
      ctx.status(`Preparing page ${p.n} for OCR…`);
      images.push(await renderForOcr(await doc.getPage(p.n)));
    }
    const texts = await recognizePages(images, lang, {
      signal: ctx.signal,
      status: ctx.status,
      onPage: (i, fraction) => ctx.progress((i + fraction) / images.length),
    });
    scanned.forEach((p, i) => {
      p.ocr = ocrBlocks(texts[i]);
      if (p.ocr.length) p.empty = false;
    });
    return { used: true, warnings: [`Text recognised with OCR (${OCR_LANGS[lang].label}): check it for mistakes`] };
  } catch (e) {
    ctx.signal?.throwIfAborted();
    return { used: false, warnings: [e.message] };
  }
}

/* ---------- Conversor ---------- */

registerConverter({
  id: "pdf",
  label: "PDF",
  extensions: ["pdf"],
  load: loadPdfjs,
  convert: async (buffer, opts, ctx) => {
    // pdf.js se queda con el buffer (lo transfiere al worker): se le pasa una copia.
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      cMapUrl: pdfAsset("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: pdfAsset("standard_fonts/"),
      wasmUrl: pdfAsset("wasm/"),
      iccUrl: pdfAsset("iccs/"),
      disableFontFace: true,
      verbosity: pdfjsLib.VerbosityLevel.ERRORS,
    });
    const abort = () => task.destroy();
    ctx.signal?.addEventListener("abort", abort);
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      ctx.signal?.throwIfAborted();
      if (e && e.name === "PasswordException") throw new Error("This PDF is password-protected.");
      throw new Error("This file isn't a valid PDF or is damaged.");
    }

    try {
      const pages = [];
      const hrefs = []; // URL de los enlaces del documento, en el orden en que aparecen
      let title = "";
      try { title = ((await doc.getMetadata()).info?.Title || "").trim(); } catch (e) {}
      // Muchos generadores dejan como título el nombre del archivo de origen: no sirve.
      if (/^(untitled|microsoft (word|powerpoint) - )|\.(docx?|pptx?|pdf|odt|indd)$/i.test(title)) title = "";

      for (let n = 1; n <= doc.numPages; n++) {
        ctx.signal?.throwIfAborted();
        const page = await doc.getPage(n);
        const [, y0, , y1] = page.view;
        const text = await page.getTextContent();
        let links = [];
        try {
          links = (await page.getAnnotations({ intent: "display" }))
            .filter((a) => a.subtype === "Link" && /^(https?:|mailto:)/i.test(a.url || ""))
            .map((a) => {
              // Mismo número para la misma URL: así se pueden unir los tramos de un enlace partido.
              let idx = hrefs.indexOf(a.url);
              if (idx < 0) idx = hrefs.push(a.url) - 1;
              return { rects: linkRects(a), idx };
            });
        } catch (e) {}
        const lines = pageLines(text.items, n, links).map((l) => ({ ...l, y: l.y - y0 }));
        let images = [];
        try {
          images = pageImages(await page.getOperatorList(), pdfjsLib.OPS).map((img) => ({ ...img, image: true, y: img.y - y0 }));
        } catch (e) {}
        // Los píxeles solo existen mientras la página está viva: se pasan a PNG antes de cleanup().
        if (opts.includeImages) {
          const done = new Map();
          for (const img of images) {
            if (img.id && done.has(img.id)) { img.blob = done.get(img.id); continue; }
            img.blob = await imageToPng(page, img).catch(() => null);
            if (img.id) done.set(img.id, img.blob);
          }
        }
        // Escaneada = sin texto, o con imagen y texto solo en la franja de cabecera/pie
        // (muchos escáneres estampan fecha o número de página).
        const chars = (list) => list.reduce((s, l) => s + l.text.replace(/\s/g, "").length, 0);
        const height = y1 - y0;
        const body = lines.filter((l) => l.y < height * 0.88 && l.y > height * 0.12);
        const empty = chars(lines) < MIN_PAGE_CHARS || (images.length > 0 && chars(body) < MIN_PAGE_CHARS);
        pages.push({ n, height, lines, images, empty });
        page.cleanup();
        ctx.progress((n / doc.numPages) * 0.9);
      }

      const ocr = await ocrScannedPages(doc, pages, opts, ctx);
      const emptyPages = pages.filter((p) => p.empty).length;
      if (emptyPages === doc.numPages) return { markdown: "", warnings: [ocr.used ? "OCR found no text in this PDF" : SCANNED_WARNING, ...ocr.warnings], images: [], title };

      removeRunningLines(pages);
      const levels = headingLevels(pages);
      // Las imágenes se colocan entre las líneas según su altura en la página.
      for (const p of pages) {
        // En las páginas pasadas por OCR la imagen escaneada ES el texto: no se deja marcador.
        p.items = p.ocr ? [] : [...p.lines];
        for (const img of p.images) {
          const at = p.items.findIndex((it) => !it.image && it.y < img.y);
          p.items.splice(at < 0 ? p.items.length : at, 0, img);
        }
      }
      const sink = createImageSink(opts.includeImages);
      const markdown = renderBlocks(buildBlocks(pages, levels), sink, hrefs);
      const warnings = [...ocr.warnings];
      if (emptyPages) warnings.push(`${emptyPages} ${emptyPages === 1 ? "page has" : "pages have"} no text layer (scanned?)`);
      warnings.push(...sink.warnings());
      ctx.progress(1);
      return { markdown, warnings, images: sink.images, title };
    } finally {
      ctx.signal?.removeEventListener("abort", abort);
      task.destroy();
    }
  },
});
