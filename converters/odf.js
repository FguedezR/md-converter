// ODT y ODP: JSZip + content.xml. Títulos, listas, tablas, notas al pie, enlaces e imágenes;
// en ODP, una sección «## Slide N — título» por diapositiva, como en PPTX.
const ODF = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
  presentation: "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
  xlink: "http://www.w3.org/1999/xlink",
};

// Elementos que no aportan texto propio o lo duplican (el índice repite los títulos).
const ODF_SKIP = ["table-of-content", "illustration-index", "alphabetical-index", "bibliography", "tracked-changes", "sequence-decls", "variable-decls", "user-field-decls", "forms", "annotation", "bookmark", "bookmark-start", "bookmark-end", "soft-page-break"];

const isOdf = (el, ns, name) => el.namespaceURI === ODF[ns] && el.localName === name;
const odfAttr = (el, ns, name) => (el ? el.getAttributeNS(ODF[ns], name) : null);

/* ---------- Estilos ---------- */

// Nombre de estilo → { parent, bold, italic } leído de styles.xml y de los estilos automáticos.
function readOdfStyles(docs) {
  const styles = new Map();
  const lists = new Map();
  for (const doc of docs) {
    if (!doc) continue;
    for (const s of doc.getElementsByTagNameNS(ODF.style, "style")) {
      const props = xmlKid(s, ODF.style, "text-properties");
      styles.set(odfAttr(s, "style", "name"), {
        parent: odfAttr(s, "style", "parent-style-name"),
        display: odfAttr(s, "style", "display-name"),
        bold: props ? /^(bold|[6-9]00)$/.test(odfAttr(props, "fo", "font-weight") || "") : undefined,
        italic: props ? /italic|oblique/.test(odfAttr(props, "fo", "font-style") || "") : undefined,
      });
    }
    // Estilo de lista → tipo por nivel (number | bullet).
    for (const ls of doc.getElementsByTagNameNS(ODF.text, "list-style")) {
      const levels = {};
      for (const lvl of ls.children) levels[+odfAttr(lvl, "text", "level") || 1] = lvl.localName === "list-level-style-number" ? "number" : "bullet";
      lists.set(odfAttr(ls, "style", "name"), levels);
    }
  }
  const resolve = (name, key) => {
    for (let s = styles.get(name), guard = 0; s && guard < 20; s = styles.get(s.parent), guard++) if (s[key] !== undefined) return s[key];
    return false;
  };
  // Cadena de nombres de un estilo de párrafo, para reconocer «Title», «Quotations», etc.
  const chain = (name) => {
    const names = [];
    for (let n = name, guard = 0; n && guard < 20; n = styles.get(n)?.parent, guard++) names.push(n, styles.get(n)?.display || "");
    return names.join("|");
  };
  return { bold: (n) => resolve(n, "bold"), italic: (n) => resolve(n, "italic"), chain, lists };
}

/* ---------- Texto en línea ---------- */

function odfSegments(el, ctx, fmt, out) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3) { out.push({ text: node.nodeValue, ...fmt }); continue; }
    if (node.nodeType !== 1) continue;
    const name = node.localName;
    if (node.namespaceURI === ODF.text) {
      if (name === "s") out.push({ text: " ".repeat(+odfAttr(node, "text", "c") || 1), ...fmt });
      else if (name === "tab") out.push({ text: " ", ...fmt });
      else if (name === "line-break") out.push({ br: true });
      else if (name === "span") {
        const style = odfAttr(node, "text", "style-name");
        odfSegments(node, ctx, { ...fmt, b: fmt.b || ctx.styles.bold(style), i: fmt.i || ctx.styles.italic(style) }, out);
      } else if (name === "a") {
        const href = node.getAttributeNS(ODF.xlink, "href") || "";
        odfSegments(node, ctx, { ...fmt, href: /^(https?:|mailto:)/i.test(href) ? href : fmt.href }, out);
      } else if (name === "note") {
        const n = ctx.footnotes.length + 1;
        const body = xmlKid(node, ODF.text, "note-body");
        ctx.footnotes.push(`[^${n}]: ${body ? odfBlocks(body, ctx).join(" ").replace(/\n+/g, " ") : ""}`);
        out.push({ raw: `[^${n}]` });
      } else if (!ODF_SKIP.includes(name)) {
        odfSegments(node, ctx, fmt, out);
      }
    } else if (node.namespaceURI === ODF.draw && name === "frame") {
      const image = xmlKid(node, ODF.draw, "image");
      const box = xmlKid(node, ODF.draw, "text-box");
      if (image) out.push({ raw: ctx.image(node, image) });
      else if (box) out.push({ text: ` ${odfBlocks(box, ctx).join(" ")} ` });
    } else if (node.namespaceURI === ODF.draw && name === "a") {
      odfSegments(node, ctx, fmt, out);
    }
  }
  return out;
}

const odfInline = (el, ctx, fmt = {}) => renderInline(odfSegments(el, ctx, fmt, []));

/* ---------- Bloques ---------- */

function odfParagraph(p, ctx) {
  const style = odfAttr(p, "text", "style-name");
  const chain = ctx.styles.chain(style);
  const text = odfInline(p, ctx, { b: ctx.styles.bold(style), i: ctx.styles.italic(style) });
  if (/(^|\|)Preformatted[_ ]?(20_)?Text(\||$)/i.test(chain)) return { code: p.textContent };
  if (!text) return null;
  if (/(^|\|)Title(\||$)/.test(chain)) return { md: `# ${text}` };
  const heading = /(^|\|)Heading[_ ](?:20_)?([1-6])(\||$)/.exec(chain);
  if (heading) return { md: `${"#".repeat(+heading[2])} ${text}` };
  if (/(^|\|)Quotations(\||$)/.test(chain)) return { md: `> ${text.replace(/\n/g, "\n> ")}` };
  return { md: text };
}

function odfList(list, ctx, depth, levels) {
  const styleName = odfAttr(list, "text", "style-name");
  levels = (styleName && ctx.styles.lists.get(styleName)) || levels || {};
  const ordered = levels[depth + 1] === "number";
  const lines = [];
  let n = 1;
  for (const item of xmlKids(list, ODF.text)) {
    if (item.localName !== "list-item" && item.localName !== "list-header") continue;
    const marker = item.localName === "list-header" ? "" : ordered ? `${n++}. ` : "- ";
    const indent = "  ".repeat(depth) + (marker ? "" : "  ");
    let first = true;
    for (const child of item.children) {
      if (isOdf(child, "text", "list")) {
        lines.push(...odfList(child, ctx, depth + 1, levels));
      } else if (isOdf(child, "text", "p") || isOdf(child, "text", "h")) {
        const text = odfInline(child, ctx);
        if (!text) continue;
        const pad = " ".repeat(marker.length);
        lines.push(`${indent}${first ? marker : pad}${text.replace(/\n/g, `\n${indent}${pad}`)}`);
        first = false;
      }
    }
  }
  return lines;
}

function odfTable(table, ctx) {
  const rows = [];
  let merged = false;
  const collect = (el) => {
    for (const child of el.children) {
      if (isOdf(child, "table", "table-row")) {
        const row = [];
        for (const cell of child.children) {
          const repeat = Math.min(64, +odfAttr(cell, "table", "number-columns-repeated") || 1);
          if (isOdf(cell, "table", "covered-table-cell")) {
            merged = true;
            for (let r = 0; r < repeat; r++) row.push("");
          } else if (isOdf(cell, "table", "table-cell")) {
            if (+odfAttr(cell, "table", "number-columns-spanned") > 1 || +odfAttr(cell, "table", "number-rows-spanned") > 1) merged = true;
            const text = odfBlocks(cell, ctx).join("<br>");
            for (let r = 0; r < repeat; r++) row.push(text);
          }
        }
        rows.push(row);
      } else if (child.namespaceURI === ODF.table && /^table-(header-rows|rows|row-group)$/.test(child.localName)) {
        collect(child);
      }
    }
  };
  collect(table);
  // Las columnas repetidas del final suelen ser celdas vacías de relleno.
  const width = Math.max(0, ...rows.map((r) => r.reduce((w, c, i) => (c ? i + 1 : w), 0)));
  if (!width) return "";
  if (merged) ctx.merged = true;
  return markdownTable(rows.map((r) => r.slice(0, width)));
}

// Devuelve los bloques Markdown de un contenedor (cuerpo, celda, cuadro de texto…).
function odfBlocks(container, ctx) {
  const blocks = [];
  let code = null;
  const flushCode = () => {
    if (code === null) return;
    const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) || []).map((r) => r.length + 1)));
    blocks.push(`${fence}\n${code}\n${fence}`);
    code = null;
  };
  for (const child of container.children) {
    if (isOdf(child, "text", "p")) {
      const p = odfParagraph(child, ctx);
      if (p && p.code !== undefined) { code = code === null ? p.code : `${code}\n${p.code}`; continue; }
      flushCode();
      if (p) blocks.push(p.md);
      continue;
    }
    flushCode();
    if (isOdf(child, "text", "h")) {
      const level = Math.min(6, Math.max(1, +odfAttr(child, "text", "outline-level") || 1));
      const text = odfInline(child, ctx);
      if (text) blocks.push(`${"#".repeat(level)} ${text}`);
    } else if (isOdf(child, "text", "list")) {
      const lines = odfList(child, ctx, 0);
      if (lines.length) blocks.push(lines.join("\n"));
    } else if (isOdf(child, "table", "table")) {
      const md = odfTable(child, ctx);
      if (md) blocks.push(md);
    } else if (child.namespaceURI === ODF.draw && child.localName === "frame") {
      const text = odfInline({ childNodes: [child] }, ctx);
      if (text) blocks.push(text);
    } else if (!ODF_SKIP.includes(child.localName)) {
      blocks.push(...odfBlocks(child, ctx));
    }
  }
  flushCode();
  return blocks;
}

/* ---------- Imágenes ---------- */

// Las imágenes se leen del ZIP antes de recorrer el documento: el recorrido es síncrono.
async function loadOdfImages(zip, doc, include) {
  const data = new Map();
  if (!include) return data;
  for (const img of doc.getElementsByTagNameNS(ODF.draw, "image")) {
    const href = img.getAttributeNS(ODF.xlink, "href") || "";
    if (!href || /^[a-z]+:/i.test(href) || data.has(href)) continue;
    data.set(href, await readZipBytes(zip, href.replace(/^\.\//, "")));
  }
  return data;
}

function odfContext(styles, sink, imageData) {
  return {
    styles,
    footnotes: [],
    merged: false,
    image: (frame, image) => {
      const alt = (xmlKid(frame, ODF.svg, "title") || xmlKid(frame, ODF.svg, "desc"))?.textContent || "";
      const href = image.getAttributeNS(ODF.xlink, "href") || "";
      return sink.add(alt.trim(), imageData.get(href), imageExt(image.getAttributeNS(ODF.draw, "mime-type"), href), href);
    },
  };
}

/* ---------- Presentaciones ---------- */

function odpSlide(page, ctx, n, withNotes) {
  let title = "";
  const blocks = [];
  const walk = (el) => {
    for (const child of el.children) {
      if (child.namespaceURI === ODF.presentation && child.localName === "notes") continue;
      if (child.namespaceURI !== ODF.draw) continue;
      if (child.localName === "g") { walk(child); continue; }
      const cls = odfAttr(child, "presentation", "class");
      if (child.localName === "frame") {
        const box = xmlKid(child, ODF.draw, "text-box");
        const table = xmlKid(child, ODF.table, "table");
        if (cls === "title" && box && !title) { title = odfBlocks(box, ctx).join(" ").replace(/^#+ /, ""); continue; }
        if (box) {
          // En los marcos «outline» las listas son viñetas aunque el estilo no lo diga.
          blocks.push(...odfBlocks(box, ctx));
        } else if (table) {
          const md = odfTable(table, ctx);
          if (md) blocks.push(md);
        } else if (xmlKid(child, ODF.draw, "image")) {
          blocks.push(ctx.image(child, xmlKid(child, ODF.draw, "image")));
        }
      } else if (["custom-shape", "rect", "ellipse", "polygon"].includes(child.localName)) {
        blocks.push(...odfBlocks(child, ctx));
      }
    }
  };
  walk(page);
  let section = `## Slide ${n}${title ? ` — ${title}` : ""}`;
  if (blocks.length) section += `\n\n${blocks.join("\n\n")}`;
  if (withNotes) {
    const notes = xmlKid(page, ODF.presentation, "notes");
    const paras = [];
    for (const frame of notes ? notes.getElementsByTagNameNS(ODF.draw, "frame") : []) {
      if (odfAttr(frame, "presentation", "class") !== "notes") continue;
      const box = xmlKid(frame, ODF.draw, "text-box");
      if (box) paras.push(...odfBlocks(box, ctx).map((b) => b.replace(/\n/g, " ")));
    }
    if (paras.length) section += `\n\n${paras.map((t, i) => (i === 0 ? `> Notes: ${t}` : `>\n> ${t}`)).join("\n")}`;
  }
  return section;
}

registerConverter({
  id: "odf",
  label: "OpenDocument",
  extensions: ["odt", "odp"],
  load: () => loadScript("/converters/zipxml.js").then(() => loadZipXml()),
  convert: async (buffer, opts, ctx) => {
    const zip = await JSZip.loadAsync(buffer);
    const content = await readXml(zip, "content.xml");
    if (!content) throw new Error("This file doesn't look like a valid OpenDocument file");
    const styles = readOdfStyles([await readXml(zip, "styles.xml"), content]);
    const sink = createImageSink(opts.includeImages);
    const c = odfContext(styles, sink, await loadOdfImages(zip, content, opts.includeImages));
    ctx.progress(0.3);

    const body = xmlKid(content.documentElement, ODF.office, "body");
    const presentation = xmlKid(body, ODF.office, "presentation");
    let markdown;
    if (presentation) {
      const pages = xmlKids(presentation, ODF.draw, "page");
      markdown = pages.map((page, i) => odpSlide(page, c, i + 1, opts.speakerNotes)).join("\n\n");
    } else {
      const text = xmlKid(body, ODF.office, "text");
      if (!text) throw new Error("This OpenDocument file has no text body (spreadsheets aren't supported)");
      markdown = odfBlocks(text, c).join("\n\n");
    }
    if (c.footnotes.length) markdown += `\n\n${c.footnotes.join("\n")}`;
    ctx.progress(1);

    const warnings = [...sink.warnings()];
    if (c.merged) warnings.unshift(MERGED_WARNING);
    return { markdown, warnings, images: sink.images, title: await packageTitle(zip) };
  },
});
