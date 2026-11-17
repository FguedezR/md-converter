// Ejecuta pandoc.wasm fuera del hilo principal (worker de módulo).
// Adaptado del puente oficial wasm/pandoc.js de pandoc 3.13 (MIT, © Tweag I/O Limited y
// John MacFarlane; ver vendor/LICENSE-pandoc-js-bridge.txt): mismo arranque del RTS de Haskell y
// misma llamada a convert(), pero con el shim WASI desde vendor/, descarga con progreso y el
// binario guardado en Cache Storage para no volver a pedirlo.
import { WASI, OpenFile, File, ConsoleStdout, PreopenDirectory } from "../vendor/browser_wasi_shim-0.3.0/index.js";

const ARGS = ["pandoc.wasm", "+RTS", "-H64m", "-RTS"];
const fileSystem = new Map();
let instance = null;

const post = (msg) => self.postMessage(msg);

async function downloadWasm(url, expectedBytes, cacheName) {
  let cache = null;
  try { cache = await caches.open(cacheName); } catch (e) {}
  const cached = cache && (await cache.match(url));
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  let res;
  try {
    res = await fetch(url, { mode: "cors" });
  } catch (e) {
    // fetch solo dice «Failed to fetch» (red caída, bloqueador, CORS): se explica algo más.
    throw new Error("Couldn't download pandoc. Check your connection or any content blocker and try again.");
  }
  if (!res.ok || !res.body) throw new Error(`Couldn't download pandoc (HTTP ${res.status})`);
  // Se cuenta sobre el tamaño conocido: con brotli en tránsito Content-Length es el comprimido y,
  // en una respuesta CORS, Content-Encoding ni siquiera es visible para saberlo.
  const total = expectedBytes;
  const bytes = new Uint8Array(total);
  const reader = res.body.getReader();
  let loaded = 0;
  let buffer = bytes;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (loaded + value.length > buffer.length) {
      const bigger = new Uint8Array(Math.max(buffer.length * 2, loaded + value.length));
      bigger.set(buffer.subarray(0, loaded));
      buffer = bigger;
    }
    buffer.set(value, loaded);
    loaded += value.length;
    post({ type: "progress", phase: "download", loaded, total });
  }
  const wasm = buffer.subarray(0, loaded);
  if (cache) {
    try { await cache.put(url, new Response(wasm, { headers: { "Content-Type": "application/wasm" } })); } catch (e) {}
  }
  return wasm;
}

async function init({ url, bytes, cacheName }) {
  const wasm = await downloadWasm(url, bytes, cacheName);
  post({ type: "progress", phase: "compile" });
  // La salida de consola de pandoc se descarta: los errores llegan por el archivo «stderr».
  const fds = [
    new OpenFile(new File(new Uint8Array(), { readonly: true })),
    ConsoleStdout.lineBuffered(() => {}),
    ConsoleStdout.lineBuffered(() => {}),
    new PreopenDirectory("/", fileSystem),
  ];
  const wasi = new WASI(ARGS, [], fds, { debug: false });
  ({ instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport }));
  wasi.initialize(instance);
  instance.exports.__wasm_call_ctors();

  const view = () => new DataView(instance.exports.memory.buffer);
  const argc = instance.exports.malloc(4);
  view().setUint32(argc, ARGS.length, true);
  const argv = instance.exports.malloc(4 * (ARGS.length + 1));
  ARGS.forEach((arg, i) => {
    const ptr = instance.exports.malloc(arg.length + 1);
    new TextEncoder().encodeInto(arg, new Uint8Array(instance.exports.memory.buffer, ptr, arg.length));
    view().setUint8(ptr + arg.length, 0);
    view().setUint32(argv + 4 * i, ptr, true);
  });
  view().setUint32(argv + 4 * ARGS.length, 0, true);
  const argvPtr = instance.exports.malloc(4);
  view().setUint32(argvPtr, argv, true);
  instance.exports.hs_init_with_rtsopts(argc, argvPtr);
}

function convert(options, stdin) {
  const optsBytes = new TextEncoder().encode(JSON.stringify(options));
  const optsPtr = instance.exports.malloc(optsBytes.length);
  new Uint8Array(instance.exports.memory.buffer, optsPtr, optsBytes.length).set(optsBytes);
  const out = new File(new Uint8Array(), { readonly: false });
  const err = new File(new Uint8Array(), { readonly: false });
  const warnings = new File(new Uint8Array(), { readonly: false });
  fileSystem.clear();
  fileSystem.set("stdin", new File(new TextEncoder().encode(stdin), { readonly: true }));
  fileSystem.set("stdout", out);
  fileSystem.set("stderr", err);
  fileSystem.set("warnings", warnings);
  instance.exports.convert(optsPtr, optsBytes.length);
  const decode = (f) => new TextDecoder().decode(f.data);
  let parsed = [];
  try { parsed = JSON.parse(decode(warnings) || "[]"); } catch (e) {}
  return { stdout: decode(out), stderr: decode(err), warnings: parsed };
}

self.onmessage = async ({ data }) => {
  try {
    if (!instance) await init(data.wasm);
    post({ type: "progress", phase: "convert" });
    post({ type: "result", ...convert(data.options, data.text) });
  } catch (e) {
    post({ type: "error", message: e && e.message ? e.message : String(e) });
  }
};
