// PDF: pdf.js extrae el texto con posiciones y aquí se reconstruye la estructura:
// títulos por tamaño de fuente, párrafos unidos, guiones de corte y cabeceras/pies repetidos.
const PDFJS_DIR = "vendor/pdfjs-6.5.438/";
const pdfAsset = (file) => new URL(PDFJS_DIR + file, location.href).href;
let pdfjsLib = null;

const SCANNED_WARNING = "This PDF looks scanned: it has no text layer to extract. Run it through an OCR tool first.";
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

/* ---------- Líneas de una página ---------- */

function pageLines(items, page) {
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
      cur = { page, x, y, xEnd: x, size, text: "", chars: new Map(), space: false, eol: false };
      lines.push(cur);
    } else if ((cur.space || x - cur.xEnd > size * 0.2) && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) {
      cur.text += " ";
    }
    cur.text += it.str;
    cur.xEnd = Math.max(cur.xEnd, x + it.width);
    cur.space = false;
    cur.eol = !!it.hasEOL;
    // El tamaño de la línea es el que tienen más caracteres (un superíndice no cuenta).
    const key = Math.round(size * 2) / 2;
    cur.chars.set(key, (cur.chars.get(key) || 0) + it.str.length);
  }
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
          blocks.push({ type: "item", ordered: !!ordered, x: line.x, text: (bullet || ordered)[2] });
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

function renderBlocks(blocks, sink) {
  const out = [];
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    const sep = i === 0 ? "" : b.type === "item" && prev.type === "item" ? "\n" : "\n\n";
    let md;
    if (b.type === "heading") md = `${"#".repeat(b.level)} ${escapeMarkdown(b.text)}`;
    else if (b.type === "item") md = `${b.ordered ? "1." : "-"} ${escapeMarkdown(b.text)}`;
    else if (b.type === "image") md = sink.add("", b.blob, "png", b.key);
    else md = escapeMarkdown(b.text);
    out.push(sep + md);
  });
  return out.join("");
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
      let emptyPages = 0;
      let title = "";
      try { title = ((await doc.getMetadata()).info?.Title || "").trim(); } catch (e) {}
      // Muchos generadores dejan como título el nombre del archivo de origen: no sirve.
      if (/^(untitled|microsoft (word|powerpoint) - )|\.(docx?|pptx?|pdf|odt|indd)$/i.test(title)) title = "";

      for (let n = 1; n <= doc.numPages; n++) {
        ctx.signal?.throwIfAborted();
        const page = await doc.getPage(n);
        const [, y0, , y1] = page.view;
        const text = await page.getTextContent();
        const lines = pageLines(text.items, n).map((l) => ({ ...l, y: l.y - y0 }));
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
        if (lines.reduce((s, l) => s + l.text.replace(/\s/g, "").length, 0) < MIN_PAGE_CHARS) emptyPages++;
        pages.push({ height: y1 - y0, lines, images });
        page.cleanup();
        ctx.progress((n / doc.numPages) * 0.9);
      }

      if (emptyPages === doc.numPages) return { markdown: "", warnings: [SCANNED_WARNING], images: [], title };

      removeRunningLines(pages);
      const levels = headingLevels(pages);
      // Las imágenes se colocan entre las líneas según su altura en la página.
      for (const p of pages) {
        p.items = [...p.lines];
        for (const img of p.images) {
          const at = p.items.findIndex((it) => !it.image && it.y < img.y);
          p.items.splice(at < 0 ? p.items.length : at, 0, img);
        }
      }
      const sink = createImageSink(opts.includeImages);
      const markdown = renderBlocks(buildBlocks(pages, levels), sink);
      const warnings = [];
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
