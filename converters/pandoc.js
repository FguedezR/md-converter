// RTF, RST y LaTeX con pandoc.wasm en un worker. El binario (59,4 MiB) vive en R2 y solo se
// descarga, tras avisar del tamaño, la primera vez que hace falta; después sale de Cache Storage.
const PANDOC_VERSION = "3.13";
const PANDOC_BASE = `https://assets.ferguedez.dev/pandoc/${PANDOC_VERSION}/`;
const PANDOC_WASM_BYTES = 62239019;
const PANDOC_CACHE = `pandoc-${PANDOC_VERSION}`;
const PANDOC_FROM = { rtf: "rtf", rst: "rst", tex: "latex" };

let pandocWorker = null;

// Mientras no exista el bucket, en local se puede usar la copia de _test/pandoc/ con ?localpandoc.
function pandocUrl() {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("localpandoc");
  return new URL("pandoc.wasm", local ? new URL("_test/pandoc/", location.href) : PANDOC_BASE).href;
}

async function pandocCached(url) {
  try {
    return !!(await (await caches.open(PANDOC_CACHE)).match(url));
  } catch (e) {
    return false;
  }
}

function stopPandoc() {
  pandocWorker?.terminate();
  pandocWorker = null;
}

function runPandoc(options, text, ctx) {
  pandocWorker ||= new Worker("workers/pandoc-worker.js", { type: "module" });
  const worker = pandocWorker;
  return new Promise((resolve, reject) => {
    const abort = () => { stopPandoc(); reject(new DOMException("Canceled", "AbortError")); };
    ctx.signal?.addEventListener("abort", abort, { once: true });
    const done = () => ctx.signal?.removeEventListener("abort", abort);
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        if (data.phase === "download") {
          const p = Math.min(1, data.loaded / data.total);
          ctx.status(`Downloading pandoc… ${fmtMiB(data.loaded)} of ${fmtMiB(data.total)}`);
          ctx.progress(p * 0.85);
        } else if (data.phase === "compile") {
          ctx.status("Starting pandoc…");
          ctx.progress(0.88);
        } else {
          ctx.status("Converting…");
          ctx.progress(0.92);
        }
      } else if (data.type === "result") {
        done();
        resolve(data);
      } else {
        // Tras un error el runtime de Haskell puede quedar inservible: se descarta el worker.
        done();
        stopPandoc();
        reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      done();
      stopPandoc();
      reject(new Error(`pandoc couldn't start: ${e.message || "worker error"}`));
    };
    worker.postMessage({ options, text, wasm: { url: pandocUrl(), bytes: PANDOC_WASM_BYTES, cacheName: PANDOC_CACHE } });
  });
}

const fmtMiB = (b) => `${(b / 1048576).toFixed(1)} MB`;

// pandoc enlaza las imágenes por ruta y aquí no existen: se cambian por el marcador del MVP.
function replacePandocImages(markdown) {
  let n = 0;
  const md = markdown.replace(/!\[((?:[^\]\\]|\\.)*)\]\([^)]*\)/g, (m, alt) => imagePlaceholder(++n, alt.replace(/\\(.)/g, "$1")));
  return { markdown: md, images: n };
}

registerConverter({
  id: "pandoc",
  label: "RTF · RST · LaTeX (pandoc)",
  extensions: ["rtf", "rst", "tex"],
  convert: async (buffer, opts, ctx) => {
    const format = opts.sourceFormat || detectPandocFormat(new Uint8Array(buffer));
    const url = pandocUrl();
    if (!pandocWorker && !(await pandocCached(url))) {
      ctx.status("Waiting for you to allow the pandoc download…");
      const ok = await ctx.confirm(`RTF, RST and LaTeX are converted with pandoc, a one-time download of about 17 MB (${fmtMiB(PANDOC_WASM_BYTES)} once unpacked). It stays cached in your browser for next time.`);
      if (!ok) throw new Error("pandoc wasn't downloaded, so this file wasn't converted.");
    }
    const { text } = decodeText(new Uint8Array(buffer));
    const result = await runPandoc({ from: PANDOC_FROM[format], to: "gfm", wrap: "none" }, text, ctx);
    if (!result.stdout.trim() && result.stderr.trim()) throw new Error(`pandoc: ${result.stderr.trim().split("\n")[0].slice(0, 200)}`);

    const { markdown, images } = replacePandocImages(result.stdout);
    const warnings = [];
    if (images) warnings.push(imagesWarning(images));
    if (/<table[\s>]/i.test(markdown)) warnings.push("Some complex tables were kept as HTML");
    ctx.progress(1);
    // pandoc deja \title{} en los metadatos, fuera del cuerpo: se recupera para el front matter.
    const title = format === "tex" ? ((/\\title\{([^{}]*)\}/.exec(text) || [])[1] || "").trim() : "";
    return { markdown, warnings, images: [], title };
  },
});

// El conversor sirve a tres formatos: convertDocument pasa el elegido en opts.sourceFormat;
// si no llega (no debería), se adivina por el contenido.
function detectPandocFormat(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  if (/^\s*\{\\rtf/.test(head)) return "rtf";
  if (/\\documentclass|\\begin\{document\}|\\section\{/.test(head)) return "tex";
  return "rst";
}
