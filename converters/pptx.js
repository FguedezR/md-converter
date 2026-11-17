// PPTX/PPSX/PPTM: JSZip + DOMParser. Una sección «## Slide N — título» por diapositiva y,
// opcionalmente, las notas del orador como bloque «> Notes:».
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

// Relaciones de una parte: id → { type, target } con la ruta ya resuelta dentro del paquete.
async function readRels(zip, part) {
  const dir = part.replace(/[^/]*$/, "");
  const doc = await readXml(zip, `${dir}_rels/${part.slice(dir.length)}.rels`);
  const rels = new Map();
  if (!doc) return rels;
  for (const rel of doc.getElementsByTagNameNS(NS_REL, "Relationship")) {
    const target = rel.getAttribute("Target") || "";
    const external = rel.getAttribute("TargetMode") === "External";
    const resolved = external ? target : target.startsWith("/") ? target.slice(1) : new URL(target, `http://x/${dir}`).pathname.slice(1);
    rels.set(rel.getAttribute("Id"), { type: rel.getAttribute("Type") || "", target: resolved, external });
  }
  return rels;
}

/* ---------- Texto con formato ---------- */

function paragraphText(p, rels) {
  const segs = [];
  for (const node of p.children) {
    if (node.namespaceURI !== NS_A) continue;
    if (node.localName === "br") { segs.push({ text: " " }); continue; }
    if (node.localName !== "r" && node.localName !== "fld") continue;
    const text = [...node.getElementsByTagNameNS(NS_A, "t")].map((t) => t.textContent).join("");
    if (!text) continue;
    const rPr = xmlKid(node, NS_A, "rPr");
    const link = rPr && xmlKid(rPr, NS_A, "hlinkClick");
    const rel = link && rels.get(link.getAttributeNS(NS_R, "id"));
    segs.push({
      text,
      b: rPr?.getAttribute("b") === "1",
      i: rPr?.getAttribute("i") === "1",
      href: rel && rel.external && /^(https?:|mailto:)/i.test(rel.target) ? rel.target : "",
    });
  }
  return renderInline(segs);
}

/* ---------- Formas ---------- */

const SKIP_PLACEHOLDERS = ["sldNum", "dt", "ftr", "hdr"];
const TITLE_PLACEHOLDERS = ["title", "ctrTitle"];

function placeholderOf(sp) {
  const ph = xmlPath(sp, [NS_P, "nvSpPr"], [NS_P, "nvPr"], [NS_P, "ph"]);
  if (!ph) return null;
  return ph.getAttribute("type") || "body";
}

// Párrafos de un cuerpo de texto como líneas Markdown; las viñetas forman listas.
function textBodyLines(txBody, rels, bulletsByDefault) {
  const lines = [];
  for (const p of xmlKids(txBody, NS_A, "p")) {
    const text = paragraphText(p, rels);
    if (!text) continue;
    const pPr = xmlKid(p, NS_A, "pPr");
    const level = Math.min(8, +(pPr?.getAttribute("lvl") || 0));
    const numbered = !!(pPr && xmlKid(pPr, NS_A, "buAutoNum"));
    const bullet = pPr && xmlKid(pPr, NS_A, "buNone") ? false : numbered || !!(pPr && xmlKid(pPr, NS_A, "buChar")) || bulletsByDefault;
    lines.push(bullet ? { list: true, md: `${"  ".repeat(level)}${numbered ? "1." : "-"} ${text}` } : { list: false, md: text });
  }
  return lines;
}

// Las líneas de lista consecutivas van juntas; el resto, separadas por una línea en blanco.
function joinLines(lines) {
  return lines.reduce((acc, l, i) => acc + (i === 0 ? "" : l.list && lines[i - 1].list ? "\n" : "\n\n") + l.md, "");
}

function tableMarkdown(tbl, rels, state) {
  const rows = xmlKids(tbl, NS_A, "tr").map((tr) => xmlKids(tr, NS_A, "tc").map((tc) => {
    if (tc.getAttribute("hMerge") === "1" || tc.getAttribute("vMerge") === "1") { state.merged = true; return ""; }
    if (+(tc.getAttribute("gridSpan") || 1) > 1 || +(tc.getAttribute("rowSpan") || 1) > 1) state.merged = true;
    const body = xmlKid(tc, NS_A, "txBody");
    return xmlKids(body, NS_A, "p").map((p) => paragraphText(p, rels)).filter(Boolean).join("<br>");
  }));
  return rows.length ? markdownTable(rows) : "";
}

// Recorre el árbol de formas en orden; de mc:AlternateContent solo se mira la primera opción.
// Las imágenes se dejan como { image } y se resuelven después (leerlas del ZIP es asíncrono).
function collectShapes(el, rels, state, out) {
  for (const node of el.children) {
    const name = node.localName;
    if (name === "sp") {
      const type = placeholderOf(node);
      if (SKIP_PLACEHOLDERS.includes(type)) continue;
      const txBody = xmlKid(node, NS_P, "txBody");
      if (!txBody) continue;
      if (TITLE_PLACEHOLDERS.includes(type)) {
        const title = xmlKids(txBody, NS_A, "p").map((p) => paragraphText(p, rels)).filter(Boolean).join(" ");
        if (title && !state.title) { state.title = title; continue; }
      }
      const lines = textBodyLines(txBody, rels, type === "body" || type === "obj");
      if (lines.length) out.push(joinLines(lines));
    } else if (name === "pic") {
      const nv = xmlPath(node, [NS_P, "nvPicPr"], [NS_P, "cNvPr"]);
      const blip = node.getElementsByTagNameNS(NS_A, "blip")[0];
      const rel = blip && rels.get(blip.getAttributeNS(NS_R, "embed"));
      out.push({ image: { alt: nv?.getAttribute("descr") || "", target: rel && !rel.external ? rel.target : "" } });
    } else if (name === "graphicFrame") {
      const tbl = node.getElementsByTagNameNS(NS_A, "tbl")[0];
      if (tbl) {
        const md = tableMarkdown(tbl, rels, state);
        if (md) out.push(md);
      }
    } else if (name === "AlternateContent") {
      if (node.firstElementChild) collectShapes(node.firstElementChild, rels, state, out);
    } else if (name === "grpSp" || name === "Choice" || name === "Fallback") {
      collectShapes(node, rels, state, out);
    }
  }
}

async function notesText(zip, slideRels) {
  const rel = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"));
  if (!rel) return "";
  const doc = await readXml(zip, rel.target);
  if (!doc) return "";
  const rels = await readRels(zip, rel.target);
  const paras = [];
  for (const sp of doc.getElementsByTagNameNS(NS_P, "sp")) {
    if (placeholderOf(sp) !== "body") continue;
    for (const p of xmlKids(xmlKid(sp, NS_P, "txBody"), NS_A, "p")) {
      const text = paragraphText(p, rels);
      if (text) paras.push(text);
    }
  }
  return notesBlock(paras);
}

const notesBlock = (paras) => paras.map((t, i) => (i === 0 ? `> Notes: ${t}` : `>\n> ${t}`)).join("\n");

registerConverter({
  id: "pptx",
  label: "PowerPoint (PPTX)",
  extensions: ["pptx", "ppsx", "pptm"],
  load: () => loadScript("/converters/zipxml.js").then(() => loadZipXml()),
  convert: async (buffer, opts, ctx) => {
    const zip = await JSZip.loadAsync(buffer);
    const presentation = await readXml(zip, "ppt/presentation.xml");
    if (!presentation) throw new Error("This file doesn't look like a valid presentation");
    const presRels = await readRels(zip, "ppt/presentation.xml");
    const slideIds = [...presentation.getElementsByTagNameNS(NS_P, "sldId")];
    const sink = createImageSink(opts.includeImages);

    const sections = [];
    let merged = false;
    for (const [i, sldId] of slideIds.entries()) {
      ctx.signal?.throwIfAborted();
      const rel = presRels.get(sldId.getAttributeNS(NS_R, "id"));
      const slide = rel && (await readXml(zip, rel.target));
      if (!slide) continue;
      const rels = await readRels(zip, rel.target);
      const state = { title: "", merged: false };
      const found = [];
      const tree = xmlPath(slide.documentElement, [NS_P, "cSld"], [NS_P, "spTree"]);
      if (tree) collectShapes(tree, rels, state, found);
      merged ||= state.merged;

      const blocks = [];
      for (const b of found) {
        if (typeof b === "string") { blocks.push(b); continue; }
        const { alt, target } = b.image;
        const data = opts.includeImages && target ? await readZipBytes(zip, target) : null;
        blocks.push(sink.add(alt, data, imageExt("", target), target));
      }

      let section = `## Slide ${i + 1}${state.title ? ` — ${state.title}` : ""}`;
      if (blocks.length) section += `\n\n${blocks.join("\n\n")}`;
      if (opts.speakerNotes) {
        const notes = await notesText(zip, rels);
        if (notes) section += `\n\n${notes}`;
      }
      sections.push(section);
      ctx.progress((i + 1) / slideIds.length);
    }

    const warnings = [...sink.warnings()];
    if (merged) warnings.unshift(MERGED_WARNING);
    return { markdown: sections.join("\n\n"), warnings, images: sink.images, title: await packageTitle(zip) };
  },
});
