// Editor de Markdown (/markdown-editor/): textarea + vista previa en vivo.
// Reutiliza de reader.js el render saneado (renderMarkdownInto), el resaltado (highlightCode),
// las anclas de títulos para el desplazamiento sincronizado (sourceHeadingOffsets, mapScroll) y
// saveBlob. Los nombres globales llevan prefijo «ed» para no chocar con los de reader.js.
const $ = (id) => document.getElementById(id);

const ED_VIEWS = ["edit", "split", "preview"];
const ED_NARROW = matchMedia("(max-width: 560px)");
const ED_INDENT = "  ";

let edDoc = { name: "untitled.md", dirty: false };
let edView = "split";
let edRenderTimer = 0;
let edHighlightTimer = 0;
let edMsgTimer = 0;
let edSyncMap = null; // { source: [y…], preview: [y…] }
let edScrollDriver = null;
let edScrollDriverTimer = 0;
let edTabTrap = true; // Esc lo desactiva para que Tab vuelva a mover el foco (accesibilidad)

const input = $("mdInput");
const preview = $("mdPreview");

/* ---------- Render y estado ---------- */

function renderNow() {
  clearTimeout(edRenderTimer);
  renderMarkdownInto(preview, input.value);
  edSyncMap = null;
  updateCounts();
  // El resaltado es lo caro: solo cuando se deja de escribir un momento.
  clearTimeout(edHighlightTimer);
  edHighlightTimer = setTimeout(() => highlightCode(preview).then(() => { edSyncMap = null; }), 600);
}

function scheduleRender() {
  clearTimeout(edRenderTimer);
  edRenderTimer = setTimeout(() => requestAnimationFrame(renderNow), 120);
}

function setDirty(dirty) {
  edDoc.dirty = dirty;
  $("dirty").hidden = !dirty;
  document.title = `${dirty ? "● " : ""}${edDoc.name} · Markdown editor`;
}

function message(text) {
  $("statusMsg").textContent = text;
  clearTimeout(edMsgTimer);
  if (text) edMsgTimer = setTimeout(() => { $("statusMsg").textContent = ""; }, 4000);
}

function updatePosition() {
  const before = input.value.slice(0, input.selectionStart);
  const line = before.split("\n").length;
  const col = input.selectionStart - before.lastIndexOf("\n");
  const selected = Math.abs(input.selectionEnd - input.selectionStart);
  $("statusPos").textContent = `Ln ${line}, Col ${col}${selected ? ` · ${selected} selected` : ""}`;
}

function updateCounts() {
  const text = input.value;
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  const minutes = Math.max(1, Math.round(words / 200));
  const n = (v) => v.toLocaleString("en-US");
  $("statusCounts").textContent = `${n(words)} word${words === 1 ? "" : "s"} · ${n(text.length)} chars${words ? ` · ~${minutes} min read` : ""}`;
}

function loadDocument(text, name) {
  edDoc.name = outputName(name);
  $("docName").value = edDoc.name;
  input.value = text;
  input.setSelectionRange(0, 0);
  input.scrollTop = 0;
  preview.scrollTop = 0;
  setDirty(false);
  renderNow();
  updatePosition();
}

/* ---------- Vistas ---------- */

function setView(view) {
  if (!ED_VIEWS.includes(view)) view = "split";
  edView = view;
  // En móvil no hay sitio para dos paneles: Split se comporta como Edit.
  const shown = ED_NARROW.matches && view === "split" ? "edit" : view;
  $("editor").dataset.view = shown;
  document.querySelectorAll("[data-editor-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.editorView === shown)));
  edSyncMap = null;
  try {
    const prefs = JSON.parse(localStorage.getItem("md-prefs") || "{}");
    localStorage.setItem("md-prefs", JSON.stringify({ ...prefs, editorView: view }));
  } catch (e) {}
}

/* ---------- Desplazamiento sincronizado (Split) ---------- */

// La Y de cada título dentro del textarea se mide con un div espejo con la misma caja y fuente:
// el texto, partido por un <span> vacío en cada título, y una sola maquetación.
function sourceAnchorTops(offsets) {
  const mirror = $("mdMirror");
  mirror.style.width = `${input.clientWidth}px`;
  const text = input.value;
  const spans = [];
  const parts = [];
  let last = 0;
  for (const offset of offsets) {
    parts.push(document.createTextNode(text.slice(last, offset)));
    const span = document.createElement("span");
    spans.push(span);
    parts.push(span);
    last = offset;
  }
  parts.push(document.createTextNode(text.slice(last)));
  mirror.replaceChildren(...parts);
  const tops = spans.map((s) => s.offsetTop);
  mirror.replaceChildren();
  return tops;
}

function buildEditorSyncMap() {
  const heads = [...preview.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  const offsets = sourceHeadingOffsets(input.value).slice(0, heads.length);
  const sourceTops = sourceAnchorTops(offsets);
  const pTop = preview.getBoundingClientRect().top - preview.scrollTop;
  const map = { source: [0], preview: [0] };
  for (let i = 0; i < Math.min(sourceTops.length, heads.length); i++) {
    const s = sourceTops[i];
    const p = heads[i].getBoundingClientRect().top - pTop;
    if (s > map.source.at(-1) && p > map.preview.at(-1)) {
      map.source.push(s);
      map.preview.push(p);
    }
  }
  map.source.push(Math.max(map.source.at(-1), input.scrollHeight - input.clientHeight));
  map.preview.push(Math.max(map.preview.at(-1), preview.scrollHeight - preview.clientHeight));
  return map;
}

// Igual que en el lector: manda el panel que empieza a moverse hasta 150 ms tras su último evento.
function syncEditorScroll(pane) {
  if ($("editor").dataset.view !== "split") return;
  if (edScrollDriver && edScrollDriver !== pane) return;
  edScrollDriver = pane;
  clearTimeout(edScrollDriverTimer);
  edScrollDriverTimer = setTimeout(() => { edScrollDriver = null; }, 150);
  requestAnimationFrame(() => {
    edSyncMap ||= buildEditorSyncMap();
    if (pane === input) preview.scrollTop = mapScroll(input.scrollTop, edSyncMap.source, edSyncMap.preview);
    else input.scrollTop = mapScroll(preview.scrollTop, edSyncMap.preview, edSyncMap.source);
  });
}

/* ---------- Edición ---------- */

// Sustituye [start, end) por `text` conservando el deshacer nativo (execCommand); si el navegador
// no lo admite, setRangeText (en ese caso Ctrl+Z no deshace la inserción).
function replaceRange(start, end, text, selStart = start + text.length, selEnd = selStart) {
  input.focus();
  input.setSelectionRange(start, end);
  let done = false;
  try {
    done = text ? document.execCommand("insertText", false, text) : start === end || document.execCommand("delete");
  } catch (e) {}
  if (!done) {
    input.setRangeText(text, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  input.setSelectionRange(selStart, selEnd);
}

// Líneas completas que toca la selección.
function selectedLines() {
  const value = input.value;
  const start = value.lastIndexOf("\n", input.selectionStart - 1) + 1;
  let endPos = input.selectionEnd;
  if (endPos > input.selectionStart && value[endPos - 1] === "\n") endPos--;
  let end = value.indexOf("\n", endPos);
  if (end === -1) end = value.length;
  return { start, end, lines: value.slice(start, end).split("\n") };
}

function wrapSelection(before, after, placeholder) {
  const { selectionStart: s, selectionEnd: e, value } = input;
  const selected = value.slice(s, e);
  // Si ya está envuelto, lo quita (B dos veces = deshacer la negrita).
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
    replaceRange(s - before.length, e + after.length, selected, s - before.length, e - before.length);
    return;
  }
  const inner = selected || placeholder;
  replaceRange(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
}

// Antepone (o quita, si todas lo llevan) un prefijo a cada línea de la selección.
function toggleLinePrefix(kind) {
  const { start, end, lines } = selectedLines();
  const patterns = {
    ul: /^(\s*)[-*+] (?!\[[ xX]\] )/,
    ol: /^(\s*)\d+[.)] /,
    task: /^(\s*)[-*+] \[[ xX]\] /,
    quote: /^(\s*)> ?/,
  };
  const re = patterns[kind];
  const content = lines.filter((l) => l.trim());
  const allHave = content.length > 0 && content.every((l) => re.test(l));
  let n = 0;
  const out = lines.map((line) => {
    if (!line.trim() && lines.length > 1) return line;
    if (allHave) return line.replace(re, "$1");
    // Quita cualquier otro marcador de lista antes de poner el nuevo.
    const bare = line.replace(/^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)/, "$1");
    const indent = /^\s*/.exec(bare)[0];
    const marker = { ul: "- ", ol: `${++n}. `, task: "- [ ] ", quote: "> " }[kind];
    return indent + marker + bare.slice(indent.length);
  });
  const text = out.join("\n");
  replaceRange(start, end, text, start, start + text.length);
}

function cycleHeading() {
  const { start, end, lines } = selectedLines();
  const line = lines[0];
  const level = (/^(#{1,6}) /.exec(line) || ["", ""])[1].length;
  const bare = line.replace(/^#{1,6} /, "");
  const next = level >= 3 ? bare : `${"#".repeat(level + 1)} ${bare}`;
  const lineEnd = lines.length > 1 ? start + line.length : end;
  replaceRange(start, lineEnd, next, start + next.length);
}

// Inserta un bloque separado por líneas en blanco de lo que tenga alrededor.
function insertBlock(block, selectFrom = 0, selectLength = 0) {
  const { selectionStart: s, selectionEnd: e, value } = input;
  const before = value.slice(0, s);
  const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const after = value.slice(e);
  const trail = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const text = lead + block + trail;
  const at = s + lead.length + selectFrom;
  replaceRange(s, e, text, at, at + selectLength);
}

const COMMANDS = {
  heading: cycleHeading,
  bold: () => wrapSelection("**", "**", "bold text"),
  italic: () => wrapSelection("_", "_", "italic text"),
  strike: () => wrapSelection("~~", "~~", "struck text"),
  code: () => wrapSelection("`", "`", "code"),
  codeblock: () => {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const body = value.slice(s, e) || "code";
    insertBlock("```\n" + body + "\n```", 4, body.length);
  },
  link: () => {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const text = value.slice(s, e);
    if (text) replaceRange(s, e, `[${text}](https://)`, s + text.length + 3, s + text.length + 11);
    else replaceRange(s, e, "[link text](https://)", s + 1, s + 10);
  },
  image: () => {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const alt = value.slice(s, e) || "description";
    replaceRange(s, e, `![${alt}](https://)`, s + alt.length + 4, s + alt.length + 12);
  },
  ul: () => toggleLinePrefix("ul"),
  ol: () => toggleLinePrefix("ol"),
  task: () => toggleLinePrefix("task"),
  quote: () => toggleLinePrefix("quote"),
  table: () => insertBlock("| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |", 2, 8),
  hr: () => insertBlock("---", 3),
};

// Enter dentro de una lista o cita la continúa; en un elemento vacío, la cierra.
function continueList(e) {
  const { selectionStart: s, selectionEnd: end, value } = input;
  if (s !== end) return;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const line = value.slice(lineStart, s);
  const m = /^(\s*)(?:([-*+]) \[[ xX]\] |([-*+]) |(\d+)([.)]) |(>) ?)/.exec(line);
  if (!m) return;
  e.preventDefault();
  if (line.trim() === m[0].trim() && value.slice(s, value.indexOf("\n", s) === -1 ? value.length : value.indexOf("\n", s)).trim() === "") {
    // Línea en blanco tras la lista: sin ella, el párrafo siguiente se pegaría al último elemento.
    replaceRange(lineStart, s, "\n");
    return;
  }
  const [, indent, taskBullet, bullet, num, delim, quote] = m;
  const marker = taskBullet ? `${taskBullet} [ ] ` : bullet ? `${bullet} ` : num ? `${+num + 1}${delim} ` : `${quote} `;
  replaceRange(s, s, `\n${indent}${marker}`);
}

function indentLines(outdent) {
  const { selectionStart: s, selectionEnd: e } = input;
  if (!outdent && !input.value.slice(s, e).includes("\n")) {
    replaceRange(s, e, ED_INDENT);
    return;
  }
  const { start, end, lines } = selectedLines();
  const out = lines.map((l) => (outdent ? l.replace(new RegExp(`^( {1,${ED_INDENT.length}}|\\t)`), "") : ED_INDENT + l));
  const text = out.join("\n");
  replaceRange(start, end, text, start, start + text.length);
}

function onEditorKeydown(e) {
  if (e.isComposing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") { edTabTrap = false; return; }
  if (e.key === "Tab" && edTabTrap && !mod && !e.altKey) {
    e.preventDefault();
    indentLines(e.shiftKey);
    return;
  }
  if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) { continueList(e); return; }
  if (!mod || e.altKey) return;
  const key = e.key.toLowerCase();
  const command = { b: "bold", i: "italic", k: e.shiftKey ? "code" : "link" }[key];
  if (command && !(key !== "k" && e.shiftKey)) {
    e.preventDefault();
    COMMANDS[command]();
  }
}

/* ---------- Archivos ---------- */

// Confirmación propia (no confirm(): bloquea la página y no se puede maquetar).
function askDiscard(text) {
  if (!edDoc.dirty) return Promise.resolve(true);
  const box = $("confirmNew");
  $("confirmNewText").textContent = text;
  box.hidden = false;
  $("confirmNewNo").focus();
  return new Promise((resolve) => {
    const finish = (answer) => {
      box.hidden = true;
      $("confirmNewYes").onclick = $("confirmNewNo").onclick = null;
      resolve(answer);
      if (!answer) input.focus();
    };
    $("confirmNewYes").onclick = () => finish(true);
    $("confirmNewNo").onclick = () => finish(false);
  });
}

async function newDocument() {
  if (!(await askDiscard("Discard your unsaved changes and start a new document?"))) return;
  loadDocument("", "untitled.md");
  input.focus();
  message("New document");
}

async function openFile(file) {
  if (!file) return;
  if (!(await askDiscard(`Discard your unsaved changes and open ${file.name}?`))) return;
  try {
    const { text } = decodeText(new Uint8Array(await file.arrayBuffer()));
    loadDocument(text, file.name);
    message(`Opened ${file.name}`);
  } catch (e) {
    message(`Couldn't open ${file.name}`);
  }
}

function downloadDocument() {
  saveBlob(new Blob([input.value], { type: "text/markdown;charset=utf-8" }), edDoc.name);
  setDirty(false);
  message(`Downloaded ${edDoc.name}`);
}

/* ---------- Eventos ---------- */

input.addEventListener("input", () => {
  if (!edDoc.dirty) setDirty(true);
  scheduleRender();
  updatePosition();
});
input.addEventListener("keydown", onEditorKeydown);
input.addEventListener("focus", () => { edTabTrap = true; });
["keyup", "click", "select"].forEach((t) => input.addEventListener(t, updatePosition));
input.addEventListener("scroll", () => syncEditorScroll(input), { passive: true });
preview.addEventListener("scroll", () => syncEditorScroll(preview), { passive: true });
window.addEventListener("resize", () => { edSyncMap = null; });
ED_NARROW.addEventListener("change", () => setView(edView));

document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => COMMANDS[b.dataset.cmd]()));
document.querySelectorAll("[data-editor-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.editorView)));

$("docName").addEventListener("change", (e) => {
  edDoc.name = outputName(e.target.value.trim() || "untitled");
  e.target.value = edDoc.name;
  setDirty(edDoc.dirty);
});
$("newDoc").addEventListener("click", newDocument);
$("openDoc").addEventListener("click", () => $("mdFile").click());
$("mdFile").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = "";
});
$("copyDoc").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(input.value);
    message("Copied to clipboard");
  } catch (e) {
    message("Couldn't copy: your browser blocked clipboard access");
  }
});
$("downloadDoc").addEventListener("click", downloadDocument);

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") { e.preventDefault(); downloadDocument(); }
  else if (key === "o") { e.preventDefault(); $("mdFile").click(); }
});

// Soltar un .md en cualquier parte lo abre (y evita que el navegador navegue al archivo).
["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));
window.addEventListener("drop", (e) => openFile(e.dataTransfer.files[0]));

window.addEventListener("beforeunload", (e) => {
  if (!edDoc.dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

let edPrefs = {};
try { edPrefs = JSON.parse(localStorage.getItem("md-prefs") || "{}"); } catch (e) {}
setView(edPrefs.editorView);
loadDocument("", "untitled.md");
input.focus();
