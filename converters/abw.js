// AbiWord: ABW es XML; ZABW es el mismo XML comprimido con gzip (DecompressionStream).
// Títulos por estilo, listas por listid/level, tablas por los «attach» de cada celda.

// Propiedades CSS-like de AbiWord: «font-weight:bold; font-style:italic».
const abwProps = (el) => Object.fromEntries((el.getAttribute("props") || "").split(";").map((p) => p.split(":").map((s) => s.trim())).filter((p) => p[0]));

function abwSegments(el, fmt, ctx, out) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3) { out.push({ text: node.nodeValue, ...fmt }); continue; }
    if (node.nodeType !== 1) continue;
    const name = node.localName;
    if (name === "c") {
      const p = abwProps(node);
      abwSegments(node, { ...fmt, b: fmt.b || p["font-weight"] === "bold", i: fmt.i || p["font-style"] === "italic" }, ctx, out);
    } else if (name === "a") {
      const href = node.getAttribute("xlink:href") || node.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
      abwSegments(node, { ...fmt, href: /^(https?:|mailto:)/i.test(href) ? href : fmt.href }, ctx, out);
    } else if (name === "br") {
      out.push({ br: true });
    } else if (name === "image") {
      ctx.images++;
      out.push({ raw: imagePlaceholder(ctx.images, node.getAttribute("alt") || node.getAttribute("title")) });
    } else if (name === "field") {
      out.push({ text: node.textContent, ...fmt });
    } else if (name === "foot" || name === "endnote") {
      const n = ctx.footnotes.length + 1;
      ctx.footnotes.push(`[^${n}]: ${abwBlocks(node, ctx).join(" ").replace(/\n+/g, " ")}`);
      out.push({ raw: `[^${n}]` });
    } else if (!["bookmark", "annotate", "ann"].includes(name)) {
      abwSegments(node, fmt, ctx, out);
    }
  }
  return out;
}

function abwTable(table, ctx) {
  const grid = [];
  for (const cell of table.children) {
    if (cell.localName !== "cell") continue;
    const p = abwProps(cell);
    const [l, r, t, b] = ["left-attach", "right-attach", "top-attach", "bot-attach"].map((k) => +p[k] || 0);
    if (r - l > 1 || b - t > 1) ctx.merged = true;
    (grid[t] ||= [])[l] = abwBlocks(cell, ctx).join("<br>");
  }
  const width = Math.max(0, ...grid.map((r) => (r ? r.length : 0)));
  if (!width) return "";
  return markdownTable([...grid].map((r) => Array.from({ length: width }, (_, i) => (r && r[i]) || "")));
}

function abwBlocks(container, ctx) {
  const blocks = [];
  // Lista en curso: cada listid de primer nivel es una lista distinta (se separa con línea en blanco).
  let list = null; // { top, lines, counters, widths }
  const flush = () => { if (list) blocks.push(list.lines.join("\n")); list = null; };
  for (const el of container.children) {
    const name = el.localName;
    if (name === "p") {
      const style = el.getAttribute("style") || "";
      const props = abwProps(el);
      const text = renderInline(abwSegments(el, {}, ctx, []));
      const listId = el.getAttribute("listid");
      if (listId && listId !== "0") {
        if (!text) continue;
        const level = Math.max(1, +el.getAttribute("level") || 1);
        const ordered = /numbered/i.test(`${style} ${props["list-style"] || ""}`);
        if (list && level === 1 && list.top !== listId) flush();
        list ||= { top: listId, lines: [], counters: {}, widths: [] };
        const n = (list.counters[listId] = (list.counters[listId] || 0) + 1);
        const marker = ordered ? `${n}. ` : "- ";
        // La sangría de un subnivel es el ancho del marcador de los niveles de encima.
        list.widths[level] = marker.length;
        const indent = Array.from({ length: level - 1 }, (_, i) => list.widths[i + 1] || 2).reduce((w, m) => w + m, 0);
        list.lines.push(`${" ".repeat(indent)}${marker}${text}`);
        continue;
      }
      flush();
      if (!text) continue;
      const heading = /^Heading ([1-6])$/i.exec(style);
      if (heading) blocks.push(`${"#".repeat(+heading[1])} ${text}`);
      else if (/^Title$/i.test(style)) blocks.push(`# ${text}`);
      else if (/^Block Text$/i.test(style)) blocks.push(`> ${text}`);
      else blocks.push(text);
    } else if (name === "table") {
      flush();
      const md = abwTable(el, ctx);
      if (md) blocks.push(md);
    } else if (name === "section" || name === "frame") {
      flush();
      blocks.push(...abwBlocks(el, ctx));
    }
  }
  flush();
  return blocks;
}

registerConverter({
  id: "abw",
  label: "AbiWord",
  extensions: ["abw", "zabw"],
  convert: async (buffer) => {
    let bytes = new Uint8Array(buffer);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") throw new Error("Your browser can't decompress ZABW files (DecompressionStream is missing)");
      bytes = await inflate(bytes, "gzip");
    }
    const doc = new DOMParser().parseFromString(decodeText(bytes).text, "application/xml");
    const root = doc.documentElement;
    if (doc.getElementsByTagName("parsererror").length || root.localName !== "abiword") throw new Error("This file doesn't look like a valid AbiWord document");

    const ctx = { images: 0, footnotes: [], merged: false };
    const sections = [...root.children].filter((el) => el.localName === "section" && !el.getAttribute("type"));
    let markdown = sections.flatMap((s) => abwBlocks(s, ctx)).join("\n\n");
    if (ctx.footnotes.length) markdown += `\n\n${ctx.footnotes.join("\n")}`;

    const title = [...root.getElementsByTagName("m")].find((m) => m.getAttribute("key") === "dc.title")?.textContent.trim() || "";
    const warnings = [];
    if (ctx.merged) warnings.push(MERGED_WARNING);
    if (ctx.images) warnings.push(imagesWarning(ctx.images));
    return { markdown, warnings, images: [], title };
  },
});
