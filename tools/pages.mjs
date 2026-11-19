// Genera las páginas por formato (/pdf-to-markdown/index.html, …), 404.html y sitemap.xml a
// partir de index.html. No es un paso de build: se ejecuta a mano y la salida se versiona.
//   node tools/pages.mjs           → escribe los archivos
//   node tools/pages.mjs --check   → solo comprueba que están al día (sale con código 1 si no)
// Hay que volver a lanzarlo cada vez que cambie index.html.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://md.ferguedez.dev";
const LASTMOD = "2026-11-19"; // cambiarla cuando cambie el contenido de las páginas
const UNSUPPORTED = "This format can’t be converted in the browser: no open-source library reads it reliably. ";

// format: valor del selector «Source format» (vacío = Auto). Los textos son únicos por página.
const PAGES = [
  {
    slug: "pdf-to-markdown", format: "pdf", name: "PDF", drop: "Drop PDF files",
    title: "PDF to Markdown converter · free, in your browser",
    description: "Convert PDF to Markdown with headings, paragraphs and lists rebuilt from the layout, and OCR for scanned pages. Free, and nothing is uploaded.",
    intro: "Convert PDF files to clean Markdown. Headings are detected from font sizes, broken lines and hyphenated words are joined, and headers and footers repeated on every page are removed. Scanned pages can be recognised with OCR in English, Spanish, French, German, Italian or Portuguese, right in your browser.",
  },
  {
    slug: "docx-to-markdown", format: "docx", name: "Word", drop: "Drop Word files",
    title: "Word to Markdown converter (DOCX, DOCM) · free",
    description: "Convert Word DOCX and DOCM documents to Markdown with headings, lists, tables, links and footnotes. Optional images in a ZIP. Runs in your browser.",
    intro: "Convert Word documents (DOCX and DOCM) to Markdown with headings, bold and italics, lists, tables, links and footnotes. Macros are never read or run. Tick “Include images (ZIP)” to get the pictures alongside the .md file.",
  },
  {
    slug: "pptx-to-markdown", format: "pptx", name: "PowerPoint", drop: "Drop PowerPoint files",
    title: "PowerPoint to Markdown converter (PPTX, PPSX) · free",
    description: "Convert PowerPoint PPTX, PPSX and PPTM to Markdown: one section per slide, bullet lists, tables and optional speaker notes. Nothing is uploaded.",
    intro: "Convert PowerPoint presentations (PPTX, PPSX and PPTM) to Markdown with one “Slide N — title” section per slide, bullet lists, tables and links. Speaker notes can be added as quotes, and images can come with it as a ZIP.",
  },
  {
    slug: "odt-to-markdown", format: "odt", name: "ODT", drop: "Drop ODT files",
    title: "ODT to Markdown converter · OpenDocument Text",
    description: "Convert OpenDocument Text (ODT) from LibreOffice or OpenOffice to Markdown with headings, lists, tables and footnotes. Free and private.",
    intro: "Convert OpenDocument Text files from LibreOffice, OpenOffice or Google Docs to Markdown: headings, lists, tables, links, quotes and footnotes are kept. The table of contents is skipped because it would only repeat the headings.",
  },
  {
    slug: "odp-to-markdown", format: "odp", name: "ODP", drop: "Drop ODP files",
    title: "ODP to Markdown converter · OpenDocument Presentation",
    description: "Convert OpenDocument presentations (ODP) to Markdown, one section per slide, with lists, tables and optional speaker notes. Runs in your browser.",
    intro: "Convert OpenDocument presentations from LibreOffice Impress or Google Slides to Markdown, with one section per slide, the bullet points and tables of each slide and, if you want, the speaker notes.",
  },
  {
    slug: "rtf-to-markdown", format: "rtf", name: "RTF", drop: "Drop RTF files",
    title: "RTF to Markdown converter · free, in your browser",
    description: "Convert Rich Text Format (RTF) files to Markdown with pandoc running in your browser. Lists, emphasis and accented characters are preserved.",
    intro: "Convert Rich Text Format documents to Markdown using pandoc compiled to WebAssembly. The first RTF you convert downloads pandoc once (about 17 MB); after that it is cached and works offline.",
  },
  {
    slug: "latex-to-markdown", format: "tex", name: "LaTeX", drop: "Drop LaTeX files",
    title: "LaTeX to Markdown converter (TEX) · free",
    description: "Convert LaTeX .tex files to GitHub-flavoured Markdown with pandoc in your browser: sections, lists, tables, links and maths are kept.",
    intro: "Convert LaTeX sources to GitHub-flavoured Markdown with pandoc. Sections become headings, itemize and enumerate become lists, tabular becomes a table and inline maths is kept. The title from \\title{} goes into the optional front matter.",
  },
  {
    slug: "rst-to-markdown", format: "rst", name: "reStructuredText", drop: "Drop RST files",
    title: "reStructuredText to Markdown converter (RST)",
    description: "Convert reStructuredText (.rst) documentation to Markdown with pandoc in your browser: headings, code blocks, lists, tables and links.",
    intro: "Convert reStructuredText documents, such as Sphinx or Python project docs, to Markdown with pandoc: headings, code blocks with their language, lists, grid tables and links are converted. Images are replaced by a marker because their files aren’t available here.",
  },
  {
    slug: "html-to-markdown", format: "html", name: "HTML", drop: "Drop HTML files",
    title: "HTML to Markdown converter · free, in your browser",
    description: "Convert HTML pages to clean Markdown: scripts, styles and hidden elements are removed; tables, code blocks and task lists are kept.",
    intro: "Convert saved web pages and HTML files to Markdown. Scripts, styles, forms and hidden elements are dropped, unsafe links are removed, and headings, lists, task lists, code blocks with their language and tables are kept.",
  },
  {
    slug: "txt-to-markdown", format: "txt", name: "Text", drop: "Drop text files",
    title: "Text to Markdown · fix encoding and open in a reader",
    description: "Open plain text files as Markdown: UTF-8, UTF-16 and Windows-1252 are detected, spacing is cleaned up and you can preview the result.",
    intro: "Turn plain text files into tidy Markdown. The encoding is detected (UTF-8, UTF-16 or Windows-1252), trailing spaces and extra blank lines are cleaned up, and you can check the result in the preview.",
  },
  {
    slug: "doc-to-markdown", format: "doc", name: "DOC", drop: "Drop Word 97–2003 files",
    title: "DOC to Markdown · old Word 97–2003 files",
    description: "Extract the text of old Word 97–2003 .doc files as Markdown, with links kept. Text only: formatting and tables are lost. Free and private.",
    intro: "Extract the text of Word 97–2003 documents (.doc) as Markdown paragraphs, keeping hyperlinks and accented characters. This is text only: headings, tables and formatting are lost. For a full conversion, save the file as DOCX first. Word 6 and Word 95 files aren’t supported.",
  },
  {
    slug: "ppt-to-markdown", format: "ppt", name: "PPT", drop: "Drop PowerPoint 97–2003 files",
    title: "PPT to Markdown · old PowerPoint 97–2003 files",
    description: "Extract the text of PowerPoint 97–2003 .ppt and .pps files as Markdown, one section per slide, with optional speaker notes. Text only.",
    intro: "Extract the text of PowerPoint 97–2003 presentations (.ppt and .pps) slide by slide, in the real slide order, with the title of each slide and, optionally, the speaker notes. Formatting and tables are lost; for a full conversion save the file as PPTX first.",
  },
  {
    slug: "abw-to-markdown", format: "abw", name: "AbiWord", drop: "Drop AbiWord files",
    title: "AbiWord to Markdown converter (ABW, ZABW)",
    description: "Convert AbiWord ABW and compressed ZABW documents to Markdown with headings, lists, tables, links and footnotes. Runs in your browser.",
    intro: "Convert AbiWord documents, both plain .abw and gzip-compressed .zabw, to Markdown with headings, numbered and bulleted lists, tables, links and footnotes.",
  },
  {
    slug: "wps-to-markdown", format: "doc", name: "WPS Writer", drop: "Drop WPS Writer files",
    title: "WPS Writer to Markdown · Kingsoft .wps files",
    description: "Extract the text of Kingsoft WPS Writer .wps documents as Markdown. Text only. Microsoft Works .wps files aren’t supported.",
    intro: "Extract the text of WPS Writer documents (.wps, from Kingsoft WPS Office) as Markdown paragraphs. They use the same structure as Word 97–2003 files, so this is text only. A .wps from Microsoft Works is a different format: see the Microsoft Works page.",
  },
  {
    slug: "dps-to-markdown", format: "ppt", name: "WPS Presentation", drop: "Drop WPS Presentation files",
    title: "WPS Presentation to Markdown · Kingsoft .dps files",
    description: "Extract the text of Kingsoft WPS Presentation .dps files as Markdown, one section per slide, with optional speaker notes. Text only.",
    intro: "Extract the text of WPS Presentation files (.dps, from Kingsoft WPS Office) slide by slide, with titles and optional speaker notes. They share the PowerPoint 97–2003 structure, so formatting and tables are lost.",
  },
  {
    slug: "markdown-viewer", format: "", name: "Markdown", drop: "Drop documents or a .md file",
    title: "Markdown viewer · read .md files in your browser",
    description: "Open and read Markdown (.md) files with a clean preview, source view, split view and table of contents. Nothing is uploaded.",
    intro: "Open a .md file to read it with a clean preview, the raw source or both side by side, plus a table of contents built from its headings. HTML inside the Markdown is sanitised and remote images are not loaded.",
  },
  {
    slug: "wpd-to-markdown", format: "", name: "WordPerfect", drop: "Drop documents",
    title: "WordPerfect (WPD) to Markdown · how to convert",
    description: "WordPerfect .wpd files can’t be converted in the browser. Save them as DOCX in WordPerfect or LibreOffice, then convert that file to Markdown here.",
    intro: `${UNSUPPORTED}Open the .wpd file in WordPerfect or in LibreOffice Writer (free), choose “Save As” → Word (.docx), and drop the new file here to get Markdown.`,
  },
  {
    slug: "lwp-to-markdown", format: "", name: "Lotus Word Pro", drop: "Drop documents",
    title: "Lotus Word Pro (LWP) to Markdown · how to convert",
    description: "Lotus Word Pro .lwp files can’t be converted in the browser. Open them in LibreOffice, save as DOCX and convert that file to Markdown here.",
    intro: `${UNSUPPORTED}LibreOffice Writer (free) can open .lwp files: open it there, choose “Save As” → Word (.docx), and drop the new file here to get Markdown.`,
  },
  {
    slug: "works-to-markdown", format: "", name: "Microsoft Works", drop: "Drop documents",
    title: "Microsoft Works (WPS) to Markdown · how to convert",
    description: "Microsoft Works .wps documents can’t be converted in the browser. Save them as DOCX with Works, Word or LibreOffice, then convert to Markdown here.",
    intro: `${UNSUPPORTED}Open the Works document in Microsoft Works, Word or LibreOffice Writer (free), save it as Word (.docx), and drop the new file here. Kingsoft WPS Writer files also use .wps and are supported: see the WPS Writer page.`,
  },
];

// Páginas escritas a mano (no salen de la plantilla) que también van al sitemap.
const EXTRA_PAGES = ["markdown-editor/"];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function seoBlock(page, url, image, { index = true } = {}) {
  const lines = [
    "  <!-- seo -->",
    `  <title>${esc(page.title)}</title>`,
    `  <meta name="description" content="${esc(page.description)}">`,
  ];
  if (!index) lines.push(`  <meta name="robots" content="noindex">`);
  else {
    lines.push(
      `  <link rel="canonical" href="${url}">`,
      `  <meta property="og:type" content="website">`,
      `  <meta property="og:site_name" content="MD Converter">`,
      `  <meta property="og:title" content="${esc(page.title)}">`,
      `  <meta property="og:description" content="${esc(page.description)}">`,
      `  <meta property="og:url" content="${url}">`,
      `  <meta property="og:image" content="${image}">`,
      `  <meta property="og:image:width" content="1200">`,
      `  <meta property="og:image:height" content="630">`,
      `  <meta property="og:image:alt" content="${esc(page.name)} to Markdown · MD Converter">`,
      `  <meta name="twitter:card" content="summary_large_image">`,
    );
  }
  lines.push("  <!-- /seo -->");
  return lines.join("\n") + "\n";
}

function render(template, page, { url, image, index = true, h1, current }) {
  let html = template;
  const replace = (pattern, value, what) => {
    if (!pattern.test(html)) throw new Error(`index.html: no encuentro ${what}`);
    html = html.replace(pattern, value);
  };
  replace(/  <!-- seo -->[\s\S]*?<!-- \/seo -->\n/, seoBlock(page, url, image, { index }), "el bloque <!-- seo -->");
  replace(/<!-- page -->[\s\S]*?<!-- \/page -->/, `<!-- page -->\n      <h1>${h1}</h1>\n      <p class="intro">${esc(page.intro)}</p>\n      <!-- /page -->`, "el bloque <!-- page -->");
  replace(/(<span id="dropTitle" class="drop-title">)[^<]*(<\/span>)/, `$1${esc(page.drop)}$2`, "#dropTitle");
  if (page.format) replace(/<html lang="en" data-accent="amber">/, `<html lang="en" data-accent="amber" data-format="${page.format}">`, "<html>");
  replace(/(<nav class="links" aria-label="Links">\n)/, `$1          <a href="/">MD Converter</a>\n`, "la navegación superior");
  if (current) replace(new RegExp(`<a href="/${current}/">`), `<a href="/${current}/" aria-current="page">`, `el enlace a /${current}/`);
  return html.replace("<!doctype html>\n", "<!doctype html>\n<!-- Generado por tools/pages.mjs a partir de index.html: no editar a mano. -->\n");
}

const template = readFileSync(join(ROOT, "index.html"), "utf8");
const outputs = new Map();
for (const page of PAGES) {
  const url = `${SITE}/${page.slug}/`;
  outputs.set(`${page.slug}/index.html`, render(template, page, {
    url, image: `${SITE}/og/${page.slug}.png`, current: page.slug,
    h1: page.slug === "markdown-viewer" ? "Markdown<br>Viewer" : `${esc(page.name)} to<br>Markdown`,
  }));
}
outputs.set("404.html", render(template, {
  title: "Page not found · MD Converter",
  description: "This page doesn’t exist. The converter still works below.",
  intro: "This page doesn’t exist. You can still drop a document below to convert it, or pick a format at the bottom of the page.",
  drop: "Drop documents", name: "MD Converter", format: "",
}, { url: "", image: "", index: false, h1: "Page not<br>found" }));
outputs.set("sitemap.xml", [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...["", ...PAGES.map((p) => `${p.slug}/`), ...EXTRA_PAGES].map((path) => `  <url><loc>${SITE}/${path}</loc><lastmod>${LASTMOD}</lastmod></url>`),
  "</urlset>",
  "",
].join("\n"));

const check = process.argv.includes("--check");
const stale = [];
for (const [file, content] of outputs) {
  const path = join(ROOT, file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) continue;
  stale.push(file);
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
if (check) {
  console.log(stale.length ? `Desactualizados (lanza node tools/pages.mjs):\n  ${stale.join("\n  ")}` : `Todo al día (${outputs.size} archivos).`);
  process.exit(stale.length ? 1 : 0);
}
console.log(stale.length ? `Escritos ${stale.length} de ${outputs.size} archivos.` : `Nada que cambiar (${outputs.size} archivos).`);
