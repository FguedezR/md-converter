// Lector: Markdown → HTML saneado (marked + DOMPurify), índice h1–h3 y vistas Preview · Source · Split.
const HLJS = "/vendor/highlight-11.12.0.min.js";
const READER_VIEWS = ["preview", "source", "split"];
const HEADING_PREFIX = "md-"; // evita choques entre las anclas del documento y los id de la página

let readerDoc = null; // { markdown, name }
let readerView = "preview";
let readerImageUrls = new Map(); // «images/image-001.png» → blob: de las imágenes extraídas
let syncMap = null; // anclas de desplazamiento en Split: { source: [y…], preview: [y…] }
let scrollDriver = null; // panel que manda mientras dura un desplazamiento
let scrollDriverTimer = 0;

// La CSP solo permite imágenes propias, data: y blob:; el resto se cambia por un marcador
// antes de insertar para que el navegador ni lo intente (y no ensucie la consola).
const isLocalImage = (src) => /^(data:image\/|blob:)/i.test(src || "");

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A" && node.hasAttribute("href")) {
    const href = node.getAttribute("href");
    if (href.startsWith("#")) node.setAttribute("href", `#${HEADING_PREFIX}${href.slice(1)}`);
    else {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
  if (node.nodeName === "IMG" && readerImageUrls.has(node.getAttribute("src"))) {
    node.setAttribute("src", readerImageUrls.get(node.getAttribute("src")));
  } else if (node.nodeName === "IMG" && !isLocalImage(node.getAttribute("src"))) {
    node.removeAttribute("src");
    node.removeAttribute("srcset");
    node.setAttribute("data-blocked", "");
  }
});

const SANITIZE = {
  FORBID_TAGS: ["style", "form", "button", "textarea", "select", "dialog", "video", "audio", "source", "picture"],
  FORBID_ATTR: ["style", "id", "name"],
  ADD_ATTR: ["target"],
  ALLOW_DATA_ATTR: false,
};

const renderMarkdown = (md) => DOMPurify.sanitize(neutralizeInlineHtml(marked.parse(md, { gfm: true, async: false })), SANITIZE);

// Anclas al estilo GitHub: estables mientras no cambie el texto del título.
function headingSlug(text, used) {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-") || "section";
  let slug = base;
  for (let n = 1; used.has(slug); n++) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

// Pinta el Markdown saneado en `el`, cambia las imágenes bloqueadas por un marcador y da a cada
// título un id estable. Devuelve las entradas h1–h3 para el índice. La comparte el editor.
function renderMarkdownInto(el, markdown) {
  el.innerHTML = renderMarkdown(markdown); // única excepción: ya pasado por DOMPurify

  el.querySelectorAll("img[data-blocked]").forEach((img) => {
    const span = document.createElement("span");
    span.className = "img-blocked";
    span.textContent = `[Image: ${img.getAttribute("alt") || "no description"}]`;
    img.replaceWith(span);
  });

  const used = new Set();
  const toc = [];
  el.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    h.id = HEADING_PREFIX + headingSlug(h.textContent, used);
    if (/^H[1-3]$/.test(h.nodeName)) toc.push({ level: +h.nodeName[1], text: h.textContent, id: h.id });
  });
  return toc;
}

function renderPreview() {
  const preview = $("mdPreview");
  renderToc(renderMarkdownInto(preview, readerDoc.markdown));
  syncMap = null;
  highlightCode(preview);
}

function renderToc(entries) {
  const list = $("tocList");
  list.replaceChildren(...entries.map((e) => {
    const li = document.createElement("li");
    li.className = `toc-${e.level}`;
    const a = document.createElement("a");
    a.href = `#${e.id}`;
    a.textContent = e.text;
    li.append(a);
    return li;
  }));
  $("tocCount").textContent = `${entries.length}`;
  $("toc").hidden = entries.length < 2;
}

// highlight.js solo se descarga si hay bloques con un lenguaje que conoce.
async function highlightCode(root) {
  const blocks = [...root.querySelectorAll("pre code[class*='language-']")];
  if (!blocks.length) return;
  try {
    await loadScript(HLJS);
  } catch (e) {
    return; // sin resaltado el documento se lee igual
  }
  hljs.configure({ ignoreUnescapedHTML: true });
  for (const el of blocks) {
    const lang = (/language-([\w+#-]+)/.exec(el.className) || [])[1];
    if (lang && hljs.getLanguage(lang) && root.contains(el)) hljs.highlightElement(el);
  }
  syncMap = null; // el resaltado puede cambiar alturas
}

function setReaderView(view) {
  if (!READER_VIEWS.includes(view)) view = "preview";
  readerView = view;
  $("reader").dataset.view = view;
  document.querySelectorAll("[data-reader-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.readerView === view)));
  syncMap = null;
  saveReaderPrefs();
}

/* ---------- Split: desplazamiento sincronizado ---------- */

// Posición de cada título ATX del fuente (fuera de bloques de código), en caracteres.
function sourceHeadingOffsets(md) {
  const offsets = [];
  let fence = null;
  let pos = 0;
  for (const line of md.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    } else if (f) {
      fence = f[1];
    } else if (/^#{1,6}(\s|$)/.test(line)) {
      offsets.push(pos);
    }
    pos += line.length + 1;
  }
  return offsets;
}

// Empareja los títulos del fuente con los renderizados (en orden) y guarda dónde está cada uno en
// su panel; entre dos anclas se interpola. Inicio y final de cada panel también son anclas.
function buildSyncMap() {
  const source = $("mdSource");
  const preview = $("mdPreview");
  const node = source.firstChild;
  const heads = [...preview.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  const offsets = sourceHeadingOffsets(readerDoc.markdown);
  const sTop = source.getBoundingClientRect().top - source.scrollTop;
  const pTop = preview.getBoundingClientRect().top - preview.scrollTop;
  const map = { source: [0], preview: [0] };
  const range = document.createRange();
  for (let i = 0; node && i < Math.min(offsets.length, heads.length); i++) {
    range.setStart(node, Math.min(offsets[i], node.length));
    range.setEnd(node, Math.min(offsets[i] + 1, node.length));
    const s = range.getBoundingClientRect().top - sTop;
    const p = heads[i].getBoundingClientRect().top - pTop;
    // Solo anclas que avanzan en los dos paneles (un título dentro de HTML crudo podría desordenarlas).
    if (s > map.source.at(-1) && p > map.preview.at(-1)) {
      map.source.push(s);
      map.preview.push(p);
    }
  }
  map.source.push(Math.max(map.source.at(-1), source.scrollHeight - source.clientHeight));
  map.preview.push(Math.max(map.preview.at(-1), preview.scrollHeight - preview.clientHeight));
  return map;
}

function mapScroll(y, from, to) {
  let i = 0;
  while (i < from.length - 2 && y >= from[i + 1]) i++;
  const span = from[i + 1] - from[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (y - from[i]) / span)) : 0;
  return to[i] + t * (to[i + 1] - to[i]);
}

// El panel que empieza a moverse manda hasta 150 ms después de su último evento: así el
// desplazamiento programado del otro no rebota.
function syncScroll(pane) {
  if (readerView !== "split" || !readerDoc) return;
  if (scrollDriver && scrollDriver !== pane) return;
  scrollDriver = pane;
  clearTimeout(scrollDriverTimer);
  scrollDriverTimer = setTimeout(() => { scrollDriver = null; }, 150);
  requestAnimationFrame(() => {
    syncMap ||= buildSyncMap();
    const fromSource = pane === $("mdSource");
    const other = fromSource ? $("mdPreview") : $("mdSource");
    other.scrollTop = fromSource ? mapScroll(pane.scrollTop, syncMap.source, syncMap.preview) : mapScroll(pane.scrollTop, syncMap.preview, syncMap.source);
  });
}

// Altura de la barra fija (y del índice) en variables CSS: el índice se pega debajo de la barra
// y los títulos dejan ese hueco al saltar a ellos.
function watchStickyHeights() {
  const reader = $("reader");
  const update = () => {
    const bar = reader.querySelector(".reader-bar").offsetHeight;
    const toc = $("toc").hidden ? 0 : $("toc").offsetHeight;
    reader.style.setProperty("--reader-bar-h", `${bar}px`);
    reader.style.setProperty("--reader-sticky-h", `${bar + toc}px`);
  };
  const observer = new ResizeObserver(update);
  observer.observe(reader.querySelector(".reader-bar"));
  observer.observe($("toc"));
  update();
}

function saveReaderPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem("md-prefs") || "{}");
    localStorage.setItem("md-prefs", JSON.stringify({ ...prefs, view: readerView }));
  } catch (e) {}
}

function showDocument(markdown, name, images = []) {
  readerImageUrls.forEach((url) => URL.revokeObjectURL(url));
  readerImageUrls = new Map(images.map((img) => [`images/${img.name}`, URL.createObjectURL(img.blob)]));
  readerDoc = { markdown, name, images };
  $("reader").hidden = false;
  $("readerName").textContent = outputName(name);
  $("downloadExt").textContent = images.length ? ".zip" : ".md";
  $("mdSource").textContent = markdown;
  renderPreview();
}

function readerStatus(text) {
  $("readerStatus").textContent = text;
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Sin imágenes, el .md suelto; con imágenes, [nombre]-md.zip con el .md y la carpeta images/.
async function downloadResult(markdown, name, images = []) {
  if (!images.length) return saveBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), outputName(name));
  await loadScript(JSZIP_SRC);
  const zip = new JSZip();
  zip.file(outputName(name), markdown);
  const folder = zip.folder("images");
  for (const img of images) folder.file(img.name, img.blob);
  saveBlob(await zip.generateAsync({ type: "blob" }), `${baseName(name) || "document"}-md.zip`);
}

async function openMarkdownFile(file) {
  try {
    const { text } = decodeText(new Uint8Array(await file.arrayBuffer()));
    showDocument(text, file.name);
    readerStatus(`Opened ${file.name}`);
    $("reader").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  } catch (e) {
    readerStatus(`Couldn't open ${file.name}`);
  }
}

function initReader() {
  watchStickyHeights();
  ["mdSource", "mdPreview"].forEach((id) => $(id).addEventListener("scroll", (e) => syncScroll(e.currentTarget), { passive: true }));
  window.addEventListener("resize", () => { syncMap = null; });
  // En Split el índice desplaza el panel de la vista previa (y el fuente le sigue), no la página.
  $("tocList").addEventListener("click", (e) => {
    const a = e.target.closest("a[href^='#']");
    if (!a) return;
    // En pantallas estrechas el índice abierto taparía media pantalla bajo la barra fija.
    if (matchMedia("(max-width: 760px)").matches) $("toc").open = false;
    if (readerView !== "split") return;
    const heading = document.getElementById(a.getAttribute("href").slice(1));
    if (!heading) return;
    e.preventDefault();
    const preview = $("mdPreview");
    preview.scrollTop += heading.getBoundingClientRect().top - preview.getBoundingClientRect().top;
  });
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem("md-prefs") || "{}"); } catch (e) {}
  setReaderView(prefs.view);

  document.querySelectorAll("[data-reader-view]").forEach((b) => b.addEventListener("click", () => setReaderView(b.dataset.readerView)));

  $("copyMd").addEventListener("click", async () => {
    if (!readerDoc) return;
    try {
      await navigator.clipboard.writeText(readerDoc.markdown);
      readerStatus("Copied to clipboard");
    } catch (e) {
      readerStatus("Couldn't copy: your browser blocked clipboard access");
    }
  });
  $("downloadMd").addEventListener("click", () => readerDoc && downloadResult(readerDoc.markdown, readerDoc.name, readerDoc.images).catch(() => readerStatus("Couldn't create the download")));
  document.querySelectorAll("[data-open-md]").forEach((b) => b.addEventListener("click", () => $("mdFile").click()));
  $("mdFile").addEventListener("change", (e) => {
    if (e.target.files[0]) openMarkdownFile(e.target.files[0]);
    e.target.value = "";
  });
}
