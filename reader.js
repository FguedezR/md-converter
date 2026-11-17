// Lector: Markdown → HTML saneado (marked + DOMPurify), índice h1–h3 y vistas Preview · Source · Split.
const HLJS = "vendor/highlight-11.12.0.min.js";
const READER_VIEWS = ["preview", "source", "split"];
const HEADING_PREFIX = "md-"; // evita choques entre las anclas del documento y los id de la página

let readerDoc = null; // { markdown, name }
let readerView = "preview";
let readerImageUrls = new Map(); // «images/image-001.png» → blob: de las imágenes extraídas

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

function renderPreview() {
  const preview = $("mdPreview");
  preview.innerHTML = renderMarkdown(readerDoc.markdown); // única excepción: ya pasado por DOMPurify

  preview.querySelectorAll("img[data-blocked]").forEach((img) => {
    const span = document.createElement("span");
    span.className = "img-blocked";
    span.textContent = `[Image: ${img.getAttribute("alt") || "no description"}]`;
    img.replaceWith(span);
  });

  const used = new Set();
  const toc = [];
  preview.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    h.id = HEADING_PREFIX + headingSlug(h.textContent, used);
    if (/^H[1-3]$/.test(h.nodeName)) toc.push({ level: +h.nodeName[1], text: h.textContent, id: h.id });
  });
  renderToc(toc);
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
}

function setReaderView(view) {
  if (!READER_VIEWS.includes(view)) view = "preview";
  readerView = view;
  $("reader").dataset.view = view;
  document.querySelectorAll("[data-reader-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.readerView === view)));
  saveReaderPrefs();
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
