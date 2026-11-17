// OCR de páginas escaneadas con tesseract.js. Lo carga pdf.js solo cuando el usuario acepta.
// Todo sale de vendor/: el worker, el núcleo wasm (tesseract elige la variante relaxed-SIMD,
// SIMD o básica según el navegador) y el modelo de idioma, que guarda después en IndexedDB.
const TESSERACT_DIR = "/vendor/tesseract-7.0.0/";
const OCR_CORE_BYTES = 3905767; // la variante más grande del núcleo (.wasm.js)

const ocrDownloadMB = (lang) => Math.round((OCR_CORE_BYTES + OCR_LANGS[lang].bytes) / 1048576);

// images: Blobs PNG, uno por página. Devuelve, por página, las líneas reconocidas en orden de
// lectura con su caja y su confianza: los párrafos se rehacen en pdf.js, porque los de tesseract
// mezclan títulos y párrafos. onPage(i, fracción) informa del avance.
async function recognizePages(images, lang, { signal, status, onPage }) {
  await loadScript(`${TESSERACT_DIR}tesseract.min.js`);
  signal?.throwIfAborted();
  let page = 0;
  let worker = null;
  // terminate() no rechaza el trabajo en curso: sin esta carrera, cancelar dejaría la promesa colgada.
  let cancel;
  const canceled = new Promise((_, reject) => { cancel = () => reject(new DOMException("Canceled", "AbortError")); });
  canceled.catch(() => {});
  const abort = () => { worker?.terminate(); cancel(); };
  signal?.addEventListener("abort", abort);
  const orCancel = (promise) => Promise.race([promise, canceled]);
  try {
    worker = await orCancel(Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
      workerPath: `${TESSERACT_DIR}worker.min.js`,
      corePath: "/vendor/tesseract-core-7.0.0",
      langPath: "/vendor/tessdata-4.0.0_best_int",
      // Worker clásico desde nuestro dominio: con Blob URL el importScripts tendría otro origen base.
      workerBlobURL: false,
      logger: (m) => {
        if (m.status === "recognizing text") onPage(page, m.progress || 0);
        else status(`Loading OCR (${OCR_LANGS[lang].label})…`);
      },
      errorHandler: () => {},
    }));
    const result = [];
    for (; page < images.length; page++) {
      signal?.throwIfAborted();
      status(`OCR page ${page + 1} of ${images.length}…`);
      const { data } = await orCancel(worker.recognize(images[page], {}, { blocks: true, text: false }));
      result.push((data.blocks || []).flatMap((block) => block.paragraphs.flatMap((p) => p.lines))
        .map((l) => ({ text: l.text.trim(), conf: l.confidence, ...l.bbox }))
        .filter((l) => l.text));
      onPage(page, 1);
    }
    return result;
  } catch (e) {
    signal?.throwIfAborted();
    throw new Error(`OCR failed: ${e && e.message ? e.message : e}`);
  } finally {
    signal?.removeEventListener("abort", abort);
    worker?.terminate();
  }
}
