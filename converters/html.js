// HTML → Markdown con turndown. docx.js reutiliza htmlToMarkdown() sobre la salida de mammoth.
const TURNDOWN = "vendor/turndown-7.2.4.js";
const TURNDOWN_GFM = "vendor/turndown-plugin-gfm-1.0.2.js";

const loadTurndown = () => Promise.all([loadScript(TURNDOWN), loadScript(TURNDOWN_GFM)]);

// Nada de esto aporta texto legible; los checkbox se quedan para las listas de tareas.
const STRIP = "script, style, md-style, noscript, template, iframe, frame, frameset, object, embed, applet, canvas, svg, audio, video, button, select, textarea, input:not([type=checkbox]), link, meta, base, [hidden], [aria-hidden=true]";
const UNSAFE_HREF = /^\s*(javascript|vbscript|data):/i;

function longestRun(text, ch) {
  const runs = text.match(new RegExp(`${ch === "`" ? "`" : "~"}+`, "g")) || [];
  return Math.max(0, ...runs.map((r) => r.length));
}

const fenceFor = (code) => "`".repeat(Math.max(3, longestRun(code, "`") + 1));

function createTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    br: "\\",
  });
  td.use([turndownPluginGfm.highlightedCodeBlock, turndownPluginGfm.taskListItems]);
  // turndown no escapa «<»: un «&lt;script&gt;» del original saldría como HTML real en el .md.
  const escape = td.escape.bind(td);
  td.escape = (text) => escape(text).replace(/</g, "\\<");

  // turndown rellena el marcador hasta 4 columnas («-   item»); aquí va «- item».
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      const parent = node.parentNode;
      let prefix = "- ";
      if (parent.nodeName === "OL") {
        const start = Number(parent.getAttribute("start")) || 1;
        prefix = `${start + [...parent.children].indexOf(node)}. `;
      }
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/^(\[[ x]\]) +/, "$1 ").replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  });

  // Tablas e imágenes llegan ya resueltas como <md-block> (ver prepareDocument).
  td.addRule("mdBlock", {
    filter: (node) => node.nodeName === "MD-BLOCK",
    replacement: (content, node) => `\n\n${node.getAttribute("data-md")}\n\n`,
  });
  td.addRule("mdInline", {
    filter: (node) => node.nodeName === "MD-INLINE",
    replacement: (content, node) => node.getAttribute("data-md"),
  });
  td.addRule("strikethrough", {
    filter: ["del", "s", "strike"],
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  });
  td.addRule("unsafeLink", {
    filter: (node) => node.nodeName === "A" && UNSAFE_HREF.test(node.getAttribute("href") || ""),
    replacement: (content) => content,
  });
  // <pre> sin <code> dentro: turndown solo reconoce <pre><code> como bloque de código.
  td.addRule("plainPre", {
    filter: (node) => node.nodeName === "PRE" && !(node.firstChild && node.firstChild.nodeName === "CODE"),
    replacement: (content, node) => {
      const code = node.textContent.replace(/\n$/, "");
      const fence = fenceFor(code);
      return `\n\n${fence}\n${code}\n${fence}\n\n`;
    },
  });
  return td;
}

// Construye la rejilla de una tabla expandiendo colspan/rowspan; las celdas cubiertas quedan vacías.
function tableGrid(table) {
  const grid = [];
  let merged = false;
  [...table.rows].forEach((row, r) => {
    grid[r] ||= [];
    let c = 0;
    [...row.cells].forEach((cell) => {
      while (grid[r][c] !== undefined) c++;
      const colspan = Math.max(1, cell.colSpan || 1);
      const rowspan = Math.max(1, Math.min(cell.rowSpan || 1, table.rows.length - r));
      if (colspan > 1 || rowspan > 1) merged = true;
      for (let dr = 0; dr < rowspan; dr++) {
        grid[r + dr] ||= [];
        for (let dc = 0; dc < colspan; dc++) grid[r + dr][c + dc] = dr === 0 && dc === 0 ? cell : null;
      }
      c += colspan;
    });
  });
  return { grid, merged };
}

// Una celda GFM es una sola línea: los saltos se convierten en <br>.
const cellMarkdown = (td, cell) => (cell ? td.turndown(cell).split(/\n+/).map((l) => l.trim().replace(/\\$/, "")).filter(Boolean).join("<br>") : "");

// Sustituye imágenes y tablas por bloques ya en Markdown antes de pasar el documento a turndown.
function prepareDocument(doc, td, sink, resolveImage) {
  doc.querySelectorAll(STRIP).forEach((el) => el.remove());
  doc.querySelectorAll("[data-md-style]").forEach((el) => {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute("data-md-style"))) el.remove();
  });

  doc.querySelectorAll("img").forEach((img) => {
    const ph = doc.createElement("md-inline");
    ph.textContent = "x"; // turndown descarta los elementos sin texto antes de mirar las reglas
    const found = resolveImage ? resolveImage(img.getAttribute("src") || "") : null;
    ph.setAttribute("data-md", sink.add(img.getAttribute("alt"), found?.data, found?.ext, found?.key));
    img.replaceWith(ph);
  });

  let merged = false;
  // De dentro hacia fuera: una tabla anidada se resuelve antes que la que la contiene.
  [...doc.querySelectorAll("table")].reverse().forEach((table) => {
    const { grid, merged: m } = tableGrid(table);
    const block = doc.createElement("md-block");
    block.textContent = "x";
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (!grid.length || !width) {
      table.remove();
      return;
    }
    if (grid.length === 1 && width === 1) {
      // Tabla de maquetación de una sola celda: se queda solo su contenido.
      const div = doc.createElement("div");
      div.append(...grid[0][0].childNodes);
      table.replaceWith(div);
      return;
    }
    merged ||= m;
    block.setAttribute("data-md", markdownTable(grid.map((row) => row.map((cell) => cellMarkdown(td, cell)))));
    table.replaceWith(block);
  });
  return { merged };
}

// input: cadena HTML o Document ya parseado. resolveImage(src) → { data, ext, key } | null permite
// a docx.js entregar los bytes de cada imagen cuando se piden en el ZIP.
function htmlToMarkdown(input, { includeImages = false, resolveImage = null } = {}) {
  const doc = typeof input === "string" ? new DOMParser().parseFromString(neutralizeInlineHtml(input), "text/html") : input;
  const td = createTurndown();
  const sink = createImageSink(includeImages);
  const { merged } = prepareDocument(doc, td, sink, resolveImage);
  const warnings = [];
  if (merged) warnings.push(MERGED_WARNING);
  warnings.push(...sink.warnings());
  const title = (doc.title || "").trim();
  return { markdown: td.turndown(doc.body || doc.documentElement), warnings, images: sink.images, title };
}

// Charset declarado en <meta> (los primeros bytes bastan); si no hay, decodeText decide.
function declaredCharset(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  return m ? m[1] : null;
}

registerConverter({
  id: "html",
  label: "HTML",
  extensions: ["html"],
  load: loadTurndown,
  convert: async (buffer) => {
    const bytes = new Uint8Array(buffer);
    const { text } = decodeText(bytes, declaredCharset(bytes));
    return htmlToMarkdown(text);
  },
});
