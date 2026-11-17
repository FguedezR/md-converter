const $ = (id) => document.getElementById(id);

// Para comparar acentos: ?accent=amber | ?accent=violet
const accentParam = new URLSearchParams(location.search).get("accent");
if (accentParam === "amber" || accentParam === "violet") document.documentElement.dataset.accent = accentParam;

const LARGE_FILE = 100 * 1024 * 1024;
// Formatos que se pueden forzar en «Source format» (uno por conversor o familia).
const FORCEABLE = ["pdf", "docx", "pptx", "html", "txt", "odt", "odp", "abw", "rtf", "rst", "tex", "doc", "ppt"];
const PRESENTATIONS = ["pptx", "ppsx", "pptm", "odp", "ppt", "pps", "dps"];

let items = []; // { id, file, format, status, result, markdown, error, progress }
let nextId = 1;
let running = null; // AbortController mientras se convierte
let shownId = null; // archivo que muestra el lector

/* ---------- Formato ---------- */

const num = (n, d = 1) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (b) => (b >= 1048576 ? num(b / 1048576) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ---------- Preferencias ---------- */

function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem("md-prefs") || "{}"); } catch (e) {}
  $("frontMatter").checked = !!p.frontMatter;
  $("speakerNotes").checked = !!p.speakerNotes;
  $("includeImages").checked = !!p.includeImages;
}

function savePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("md-prefs") || "{}");
    localStorage.setItem("md-prefs", JSON.stringify({ ...p, frontMatter: $("frontMatter").checked, speakerNotes: $("speakerNotes").checked, includeImages: $("includeImages").checked }));
  } catch (e) {}
}

const options = () => ({ frontMatter: $("frontMatter").checked, speakerNotes: $("speakerNotes").checked, includeImages: $("includeImages").checked });
const forcedFormat = () => ($("sourceFormat").value === "auto" ? null : $("sourceFormat").value);
const effectiveFormat = (item) => forcedFormat() || item.format;

/* ---------- Soporte del navegador ---------- */

function supportsModuleWorkers() {
  let supported = false;
  const url = URL.createObjectURL(new Blob([""], { type: "text/javascript" }));
  try {
    new Worker(url, { get type() { supported = true; return "module"; } }).terminate();
  } catch (e) {}
  URL.revokeObjectURL(url);
  return supported;
}

function checkSupport() {
  const missing = [];
  if (typeof DecompressionStream === "undefined") missing.push("DecompressionStream (needed to read DOCX and PPTX)");
  if (!supportsModuleWorkers()) missing.push("module workers (needed for PDF)");
  if (!missing.length) return;
  const box = $("support");
  const p = document.createElement("p");
  p.textContent = `Your browser lacks ${missing.join(" and ")}. Update it or use a recent Chrome, Edge, Firefox or Safari.`;
  box.replaceChildren(p);
  box.hidden = false;
}

/* ---------- Tabla de archivos ---------- */

function resultCell(item) {
  const td = document.createElement("td");
  const msg = document.createElement("span");
  const status = item.status;
  if (status === "error") { msg.className = "err"; msg.textContent = item.error; }
  else if (status === "unsupported") { msg.className = "err"; msg.textContent = UNSUPPORTED_MESSAGE; }
  else if (status === "working") msg.textContent = item.statusText || `Converting… ${Math.round(item.progress * 100)}%`;
  else if (status === "done") {
    msg.className = "ok";
    const images = item.result.images.length;
    msg.textContent = `${fmt(new Blob([item.markdown]).size)} of Markdown${images ? ` · ${plural(images, "image")}` : ""}`;
  }
  else if (status === "queued") { msg.className = "dim"; msg.textContent = item.result ? "Options changed: convert again" : "Ready to convert"; }
  else { msg.className = "dim"; msg.textContent = statusMessage(effectiveFormat(item)); }
  td.append(msg);
  const notes = [...(item.result?.warnings || [])];
  if (item.file.size > LARGE_FILE && status === "queued") notes.push(`Large file (${fmt(item.file.size)}): conversion may be slow and use a lot of memory`);
  if (FORMATS[effectiveFormat(item)]?.textOnly && status === "queued") notes.push("Text only: headings, tables and formatting are lost");
  if (notes.length) {
    const ul = document.createElement("ul");
    ul.className = "warns";
    ul.append(...notes.map((w) => Object.assign(document.createElement("li"), { textContent: w })));
    td.append(ul);
  }
  return td;
}

function actionButton(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderTable() {
  const tbody = $("files").tBodies[0];
  tbody.replaceChildren(...items.map((item) => {
    const tr = document.createElement("tr");
    if (item.id === shownId) tr.className = "active";
    const name = document.createElement("td");
    name.textContent = item.file.name;
    const format = document.createElement("td");
    const f = effectiveFormat(item);
    format.textContent = FORMATS[f]?.label || "Unknown";
    format.className = "dim";
    const size = document.createElement("td");
    size.className = "num";
    size.textContent = fmt(item.file.size);
    const actions = document.createElement("td");
    actions.className = "num";
    if (item.status === "done" && item.markdown) {
      actions.append(
        actionButton("View", () => showItem(item, true)),
        actionButton(item.result.images.length ? "↓ .zip" : "↓ .md", () => downloadResult(item.markdown, item.file.name, item.result.images).catch(() => summary("Couldn't create the download.", true))),
      );
    }
    tr.append(name, format, size, resultCell(item), actions);
    return tr;
  }));
  $("files").hidden = !items.length;
  refreshButtons();
}

function refreshButtons() {
  const pending = items.some((i) => i.status === "queued");
  $("convert").textContent = running ? "Cancel" : "Convert";
  $("convert").disabled = !running && !pending;
  $("clear").disabled = !!running || !items.length;
  $("sourceFormat").disabled = !!running;
  $("drop").classList.toggle("busy", !!running);
}

function summary(text, isError = false) {
  const el = $("summary");
  el.replaceChildren();
  const span = document.createElement("span");
  if (isError) span.className = "err";
  span.textContent = text;
  el.append(span);
}

function setProgress(fraction) {
  $("progress").hidden = fraction === null;
  $("progressBar").style.width = `${Math.round((fraction || 0) * 100)}%`;
}

/* ---------- Archivos ---------- */

// Estado inicial según el formato detectado (o forzado).
function initialStatus(format) {
  const s = formatStatus(format);
  return s === "ready" ? "queued" : s;
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const markdownFiles = [];
  for (const file of files) {
    let format = "unknown";
    try {
      ({ format } = await detectFormat(new Uint8Array(await file.arrayBuffer()), file.name));
    } catch (e) {}
    if (format === "md" && !forcedFormat()) { markdownFiles.push(file); continue; }
    const item = { id: nextId++, file, format, status: "queued", result: null, markdown: "", error: "", progress: 0 };
    item.status = initialStatus(effectiveFormat(item));
    items.push(item);
  }
  if (markdownFiles.length) await openMarkdownFile(markdownFiles[markdownFiles.length - 1]);
  renderTable();

  const queued = items.filter((i) => i.status === "queued");
  const large = queued.filter((i) => i.file.size > LARGE_FILE);
  const parts = [];
  if (queued.length) parts.push(`${plural(queued.length, "file")} ready. Press Convert.`);
  else if (!markdownFiles.length) parts.push("Nothing to convert in that selection.");
  if (large.length) parts.push(`${plural(large.length, "file")} over 100 MB: it may take a while.`);
  if (markdownFiles.length > 1) parts.push("Several .md files: the reader shows the last one.");
  if (parts.length) summary(parts.join(" "));
}

function showItem(item, scroll) {
  shownId = item.id;
  showDocument(item.markdown, item.file.name, item.result.images);
  readerStatus("");
  renderTable();
  if (scroll) $("reader").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

// Recalcula el Markdown final (front matter) sin reconvertir.
function refinalize(item) {
  if (!item.result) return;
  item.markdown = finalizeMarkdown(item.result, item.file.name, options());
}

/* ---------- Conversión ---------- */

// Pide permiso antes de una descarga grande (pandoc). Cancelar la conversión también la cierra.
function askConsent(message, signal) {
  const box = $("consent");
  $("consentText").textContent = message;
  box.hidden = false;
  $("consentYes").focus();
  return new Promise((resolve) => {
    const finish = (answer) => {
      box.hidden = true;
      $("consentYes").onclick = $("consentNo").onclick = null;
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort);
    $("consentYes").onclick = () => finish(true);
    $("consentNo").onclick = () => finish(false);
  });
}

async function convertAll() {
  const queue = items.filter((i) => i.status === "queued");
  if (!queue.length) return;
  running = new AbortController();
  const { signal } = running;
  const opts = options();
  let ok = 0;
  let failed = 0;
  setProgress(0);
  refreshButtons();

  for (const [index, item] of queue.entries()) {
    if (signal.aborted) break;
    item.status = "working";
    item.progress = 0;
    item.statusText = "";
    item.result = null;
    renderTable();
    summary(`Converting ${item.file.name} (${index + 1} of ${queue.length})…`);
    let lastPaint = 0;
    // La tabla se repinta como mucho cada 150 ms: un PDF largo informa en cada página.
    const repaint = () => { if (performance.now() - lastPaint > 150) { lastPaint = performance.now(); renderTable(); } };
    const onProgress = (p) => {
      item.progress = p;
      setProgress((index + p) / queue.length);
      repaint();
    };
    const onStatus = (text) => {
      item.statusText = text;
      repaint();
    };
    try {
      const buffer = await item.file.arrayBuffer();
      item.result = await convertDocument(buffer, effectiveFormat(item), opts, { signal, onProgress, onStatus, confirm: (message) => askConsent(message, signal) });
      if (!item.result.markdown.trim()) {
        item.status = "error";
        item.error = "No text could be extracted.";
        failed++;
      } else {
        refinalize(item);
        item.status = "done";
        ok++;
        if (shownId === null || !items.some((i) => i.id === shownId && i.status === "done")) showItem(item, false);
        else if (shownId === item.id) showItem(item, false);
      }
    } catch (e) {
      if (signal.aborted) {
        item.status = "queued";
        break;
      }
      item.status = "error";
      item.error = e && e.message ? e.message : "Conversion failed.";
      failed++;
    }
    setProgress((index + 1) / queue.length);
  }

  const canceled = signal.aborted;
  running = null;
  setProgress(null);
  renderTable();
  const parts = [];
  if (ok) parts.push(`${plural(ok, "file")} converted.`);
  if (failed) parts.push(`${plural(failed, "file")} failed.`);
  if (canceled) parts.push("Canceled.");
  summary(parts.join(" ") || "Nothing converted.", failed > 0 && !ok);
}

/* ---------- Eventos ---------- */

function fillFormatSelect() {
  const select = $("sourceFormat");
  for (const f of FORCEABLE) {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = FORMATS[f].label + (formatStatus(f) === "soon" ? " · coming soon" : "");
    select.append(o);
  }
}

// Cambiar formato o notas obliga a reconvertir; el front matter solo a renormalizar.
function invalidate(predicate) {
  for (const item of items) {
    if (item.status === "working") continue;
    if (!predicate(item)) continue;
    item.status = initialStatus(effectiveFormat(item));
  }
  renderTable();
  if (items.some((i) => i.status === "queued" && i.result)) summary("Options changed. Press Convert to apply them.");
}

$("sourceFormat").addEventListener("change", () => invalidate(() => true));
$("speakerNotes").addEventListener("change", () => {
  savePrefs();
  invalidate((item) => PRESENTATIONS.includes(effectiveFormat(item)) && !!item.result);
});
$("includeImages").addEventListener("change", () => {
  savePrefs();
  invalidate((item) => IMAGE_FORMATS.includes(effectiveFormat(item)) && !!item.result);
});
$("frontMatter").addEventListener("change", () => {
  savePrefs();
  items.forEach(refinalize);
  const shown = items.find((i) => i.id === shownId && i.status === "done");
  if (shown) showItem(shown, false);
  renderTable();
});

$("convert").addEventListener("click", () => (running ? running.abort() : convertAll()));
$("clear").addEventListener("click", () => {
  items = [];
  shownId = null;
  renderTable();
  summary("Waiting for documents.");
});

$("file").addEventListener("change", (e) => {
  addFiles(e.target.files);
  e.target.value = ""; // permite volver a elegir el mismo archivo
});

// Evita que soltar fuera de la zona haga que el navegador abra el archivo.
["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));

const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, () => drop.classList.add("over")));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); }
});
drop.addEventListener("drop", (e) => {
  if (running) return;
  if (!e.dataTransfer.files.length) return summary("Couldn't read what you dropped.", true);
  addFiles(e.dataTransfer.files);
});

fillFormatSelect();
loadPrefs();
initReader();
checkSupport();
