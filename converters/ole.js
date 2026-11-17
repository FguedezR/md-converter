// Formatos binarios antiguos, solo texto: DOC (y WPS de Kingsoft) y PPT/PPS (y DPS de Kingsoft).
// cfb (SheetJS) abre el contenedor OLE; el texto se saca a mano según [MS-DOC] y [MS-PPT].
const CFB_SRC = "vendor/cfb-1.2.2.min.js";
const TEXT_ONLY_WARNING = "Text only: headings, tables and formatting are lost";

const oleStream = (cfb, name) => {
  const entry = CFB.find(cfb, name);
  if (!entry || !entry.content) return null;
  return entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
};
const oleView = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// Páginas de códigos de las propiedades que no siguen el patrón «windows-NNNN».
const OLE_CODEPAGES = { 1200: "utf-16le", 65001: "utf-8", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5", 10000: "macintosh", 20127: "us-ascii", 28591: "iso-8859-1" };

// Título de \x05SummaryInformation (propiedad 2, PIDSI_TITLE), para el front matter.
function oleTitle(cfb) {
  try {
    const s = oleStream(cfb, "\u0005SummaryInformation");
    if (!s || s.length < 48) return "";
    const v = oleView(s);
    const section = v.getUint32(44, true);
    const count = v.getUint32(section + 4, true);
    const props = new Map();
    for (let i = 0; i < Math.min(count, 64); i++) props.set(v.getUint32(section + 8 + i * 8, true), section + v.getUint32(section + 12 + i * 8, true));
    const at = props.get(2);
    if (!at || v.getUint32(at, true) !== 0x1e) return "";
    const cp = props.has(1) ? v.getInt16(props.get(1) + 4, true) & 0xffff : 1252;
    const len = v.getUint32(at + 4, true);
    const raw = s.subarray(at + 8, at + 8 + len);
    const label = OLE_CODEPAGES[cp] || `windows-${cp}`;
    let text;
    try { text = new TextDecoder(label).decode(raw); } catch (e) { text = new TextDecoder("windows-1252").decode(raw); }
    return text.replace(/\0[\s\S]*$/, "").trim();
  } catch (e) {
    return "";
  }
}

/* ---------- DOC ---------- */

// Texto del documento principal a partir de la tabla de piezas (Clx) del FIB de Word 97+.
function docRawText(cfb) {
  const wd = oleStream(cfb, "WordDocument");
  if (!wd || wd.length < 0x1aa) throw new Error("This Word file is damaged");
  const v = oleView(wd);
  // 0xA5DC es la firma de Word 6/95; 0xA5EC, la de Word 97 en adelante.
  const ident = v.getUint16(0, true);
  if (ident !== 0xa5ec && ident !== 0xa5dc) throw new Error("This Word file is damaged");
  if (ident === 0xa5dc || v.getUint16(2, true) < 0xc1) throw new Error("Word 6 and Word 95 files aren't supported. Save it as DOCX in your word processor and convert that file.");
  const flags = v.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error("This document is password-protected.");
  const table = oleStream(cfb, flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new Error("This Word file is damaged (no table stream)");
  const t = oleView(table);
  const ccpText = v.getInt32(0x4c, true);
  const fcClx = v.getUint32(0x1a2, true);
  const end = Math.min(table.length, fcClx + v.getUint32(0x1a6, true));

  // Clx = Prc* (datos de formato, se saltan) + Pcdt (la tabla de piezas).
  let p = fcClx;
  while (p < end && table[p] === 0x01) p += 3 + t.getInt16(p + 1, true);
  if (table[p] !== 0x02) throw new Error("This Word file is damaged (no piece table)");
  const lcb = t.getUint32(p + 1, true);
  const plc = p + 5;
  const n = Math.floor((lcb - 4) / 12);
  const cp = (i) => t.getUint32(plc + i * 4, true);

  let text = "";
  for (let i = 0; i < n && cp(i) < ccpText; i++) {
    const len = Math.min(cp(i + 1), ccpText) - cp(i);
    if (len <= 0) continue;
    const fcRaw = t.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const fc = fcRaw & 0x3fffffff;
    // Bit 30: la pieza está en Windows-1252 (1 byte por carácter) en fc/2; si no, en UTF-16LE.
    text += fcRaw & 0x40000000
      ? new TextDecoder("windows-1252").decode(wd.subarray(fc / 2, fc / 2 + len))
      : new TextDecoder("utf-16le").decode(wd.subarray(fc, fc + len * 2));
  }
  return text;
}

// Recorre los caracteres especiales de Word: campos (\x13 código \x14 resultado \x15), finales de
// párrafo y celda, imágenes (\x01, \x08). De HYPERLINK se conserva el enlace.
function docParagraphs(text, sink) {
  const paras = [];
  const stack = [];
  let segs = [];
  let buf = "";
  const href = () => [...stack].reverse().find((f) => f.result && f.href)?.href || "";
  const flush = () => { if (buf) segs.push({ text: buf, href: href() }); buf = ""; };
  const endPara = () => { flush(); paras.push(segs); segs = []; };
  for (const ch of text) {
    const top = stack[stack.length - 1];
    if (ch === "\x13") { flush(); stack.push({ code: "", result: false, href: "" }); continue; }
    if (ch === "\x14") {
      if (top && !top.result) {
        const m = /^\s*HYPERLINK\s+(?:\\[a-z]\s+)*"([^"]+)"/i.exec(top.code);
        flush();
        top.result = true;
        top.href = m && /^(https?:|mailto:)/i.test(m[1]) ? m[1] : "";
      }
      continue;
    }
    if (ch === "\x15") { flush(); stack.pop(); continue; }
    if (stack.some((f) => !f.result)) {
      if (top && !top.result) top.code += ch;
      continue;
    }
    if (ch === "\r" || ch === "\x07" || ch === "\x0c") endPara();
    else if (ch === "\x0b") { flush(); segs.push({ br: true }); }
    else if (ch === "\x01" || ch === "\x08") { flush(); segs.push({ raw: ` ${sink.add("")} ` }); }
    else if (ch === "\x1e") buf += "-";
    else if (ch === "\t") buf += " ";
    else if (ch >= " " && ch !== "\x1f") buf += ch;
  }
  endPara();
  return paras.map(renderInline).filter(Boolean);
}

/* ---------- PPT ---------- */

const PPT = {
  Document: 0x03e8, Slide: 0x03ee, SlideAtom: 0x03ef, Notes: 0x03f0, SlidePersistAtom: 0x03f3,
  TextHeaderAtom: 0x0f9f, TextCharsAtom: 0x0fa0, TextBytesAtom: 0x0fa8, SlideListWithText: 0x0ff0,
  UserEditAtom: 0x0ff5, PersistDirectoryAtom: 0x1772,
};
const PPT_TITLE = [0, 6]; // Title, CenterTitle
const PPT_NOTES = 2;

function pptReader(bytes) {
  const v = oleView(bytes);
  const u32 = (at) => (at + 4 <= bytes.length ? v.getUint32(at, true) : 0);
  const record = (at) => {
    if (at < 0 || at + 8 > bytes.length) return null;
    const vi = v.getUint16(at, true);
    const start = at + 8;
    return { ver: vi & 0xf, inst: vi >> 4, type: v.getUint16(at + 2, true), start, end: Math.min(bytes.length, start + v.getUint32(at + 4, true)) };
  };
  function* children(rec) {
    for (let at = rec.start, guard = 0; at + 8 <= rec.end && guard < 1e6; guard++) {
      const r = record(at);
      if (!r || r.end <= at) return;
      yield r;
      at = r.end;
    }
  }
  const text = (r) => (r.type === PPT.TextCharsAtom
    ? new TextDecoder("utf-16le").decode(bytes.subarray(r.start, r.end))
    : Array.from(bytes.subarray(r.start, r.end), (b) => String.fromCharCode(b)).join(""));
  // Todos los textos bajo un contenedor, con el tipo del TextHeaderAtom que los precede.
  const texts = (rec, out = [], state = { type: 4 }) => {
    for (const r of children(rec)) {
      if (r.type === PPT.TextHeaderAtom) state.type = u32(r.start);
      else if (r.type === PPT.TextCharsAtom || r.type === PPT.TextBytesAtom) out.push({ type: state.type, text: text(r) });
      else if (r.ver === 0xf) texts(r, out, state);
    }
    return out;
  };
  return { u32, record, children, text, texts };
}

// Directorio de persistencia: id → posición en el stream, desde el UserEditAtom más reciente.
function pptPersist(ppt, currentUser) {
  const map = new Map();
  let docRef = 0;
  let encrypted = false;
  let edit = currentUser && currentUser.length >= 20 ? oleView(currentUser).getUint32(16, true) : 0;
  for (let guard = 0; edit && guard < 1000; guard++) {
    const ue = ppt.record(edit);
    if (!ue || ue.type !== PPT.UserEditAtom) break;
    docRef ||= ppt.u32(ue.start + 16);
    if (ue.end - ue.start >= 32 && ppt.u32(ue.start + 28)) encrypted = true;
    const dir = ppt.record(ppt.u32(ue.start + 12));
    if (dir && dir.type === PPT.PersistDirectoryAtom) {
      for (let at = dir.start; at + 4 <= dir.end;) {
        const entry = ppt.u32(at);
        const id = entry & 0xfffff;
        const count = entry >>> 20;
        at += 4;
        for (let k = 0; k < count && at + 4 <= dir.end; k++, at += 4) if (!map.has(id + k)) map.set(id + k, ppt.u32(at));
      }
    }
    edit = ppt.u32(ue.start + 8);
  }
  return { map, docRef, encrypted };
}

const pptParagraphs = (text) => text.split("\r").map((p) => renderInline(p.split("\x0b").flatMap((t, i) => (i ? [{ br: true }, { text: t }] : [{ text: t }])))).filter((p) => p && p !== "\\*");

function pptSlides(bytes, currentUser, withNotes) {
  const ppt = pptReader(bytes);
  const { map, docRef, encrypted } = pptPersist(ppt, currentUser);
  if (encrypted) throw new Error("This presentation is password-protected.");
  const at = (ref) => (map.has(ref) ? ppt.record(map.get(ref)) : null);
  const doc = at(docRef);
  if (!doc || doc.type !== PPT.Document) return null;

  // SlideListWithText: instancia 0 = diapositivas, 2 = notas. Guarda el texto de los marcadores.
  const lists = { 0: [], 2: new Map() };
  for (const r of ppt.children(doc)) {
    if (r.type !== PPT.SlideListWithText || (r.inst !== 0 && r.inst !== 2)) continue;
    let cur = null;
    let type = 4;
    for (const c of ppt.children(r)) {
      if (c.type === PPT.SlidePersistAtom) {
        // SlidePersistAtom: persistIdRef en 0 y slideId en 12 (SlideAtom enlaza las notas por slideId).
        cur = { ref: ppt.u32(c.start), slideId: ppt.u32(c.start + 12), texts: [] };
        if (r.inst === 0) lists[0].push(cur);
        else lists[2].set(cur.slideId, cur);
      } else if (c.type === PPT.TextHeaderAtom) type = ppt.u32(c.start);
      else if (cur && (c.type === PPT.TextCharsAtom || c.type === PPT.TextBytesAtom)) cur.texts.push({ type, text: ppt.text(c) });
    }
  }

  return lists[0].map(({ ref, texts }) => {
    const slide = at(ref);
    const all = [...texts];
    let notes = [];
    if (slide && slide.type === PPT.Slide) {
      all.push(...ppt.texts(slide));
      const atom = [...ppt.children(slide)].find((c) => c.type === PPT.SlideAtom);
      const notesId = atom ? ppt.u32(atom.start + 16) : 0;
      const notesEntry = lists[2].get(notesId);
      if (withNotes && notesEntry) {
        const n = at(notesEntry.ref);
        notes = [...notesEntry.texts, ...(n && n.type === PPT.Notes ? ppt.texts(n) : [])];
      }
    }
    const seen = new Set();
    const unique = (list) => list.filter((t) => t.text.trim() && !seen.has(t.text) && seen.add(t.text));
    const body = unique(all.filter((t) => t.type !== PPT_NOTES));
    const titleEntry = body.find((t) => PPT_TITLE.includes(t.type));
    return {
      title: titleEntry ? pptParagraphs(titleEntry.text).join(" ") : "",
      body: body.filter((t) => t !== titleEntry).flatMap((t) => pptParagraphs(t.text)),
      notes: unique(notes.filter((t) => t.type === PPT_NOTES)).flatMap((t) => pptParagraphs(t.text)),
    };
  });
}

// Si el directorio de persistencia no se puede leer, todo el texto en orden, en una sola sección.
function pptFallback(bytes) {
  const ppt = pptReader(bytes);
  const root = { start: 0, end: bytes.length };
  const seen = new Set();
  return ppt.texts(root).filter((t) => t.text.trim() && !seen.has(t.text) && seen.add(t.text)).flatMap((t) => pptParagraphs(t.text));
}

/* ---------- Conversor ---------- */

registerConverter({
  id: "ole",
  label: "Legacy Office (text only)",
  extensions: ["doc", "ppt", "pps", "wps", "dps"],
  load: () => loadScript(CFB_SRC),
  convert: async (buffer, opts, ctx) => {
    let cfb;
    try {
      cfb = CFB.read(new Uint8Array(buffer), { type: "array" });
    } catch (e) {
      throw new Error("This file isn't a valid Office 97–2003 document or is damaged.");
    }
    const word = CFB.find(cfb, "WordDocument");
    const powerpoint = CFB.find(cfb, "PowerPoint Document");
    const wantsSlides = ["ppt", "pps", "dps"].includes(opts.sourceFormat);
    const kind = word && powerpoint ? (wantsSlides ? "ppt" : "doc") : word ? "doc" : powerpoint ? "ppt" : null;
    if (!kind) {
      throw new Error(["wps", "dps"].includes(opts.sourceFormat)
        ? "This Kingsoft file uses a structure that can't be read here. Save it as DOCX or PPTX in WPS Office and convert that file."
        : "This file doesn't contain a Word or PowerPoint document.");
    }
    const sink = createImageSink(false);
    let markdown;
    try {
      if (kind === "doc") {
        markdown = docParagraphs(docRawText(cfb), sink).join("\n\n");
      } else {
        const bytes = oleStream(cfb, "PowerPoint Document");
        const slides = pptSlides(bytes, oleStream(cfb, "Current User"), opts.speakerNotes);
        markdown = slides
          ? slides.map((s, i) => [
            `## Slide ${i + 1}${s.title ? ` — ${s.title}` : ""}`,
            ...s.body,
            ...(s.notes.length ? [s.notes.map((t, j) => (j === 0 ? `> Notes: ${t}` : `>\n> ${t}`)).join("\n")] : []),
          ].join("\n\n")).join("\n\n")
          : `## Slides\n\n${pptFallback(bytes).join("\n\n")}`;
      }
    } catch (e) {
      // Los mensajes propios (cifrado, Word 95…) se respetan; el resto es un archivo dañado.
      if (/password|Word 6|damaged/.test(e.message)) throw e;
      throw new Error("This file is damaged or uses a variant that can't be read here.");
    }
    ctx.progress(1);
    return { markdown, warnings: [TEXT_ONLY_WARNING, ...sink.warnings()], images: [], title: oleTitle(cfb) };
  },
});
