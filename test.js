// Banco de pruebas: convierte cada caso de _test/manifest.json con el mismo código que la app
// y compara con su .expected.md. Va en archivo aparte porque la CSP no permite scripts en línea.
const $ = (id) => document.getElementById(id);
const FIXED_DATE = "2000-01-01T00:00:00Z"; // la fecha del front matter cambiaría en cada ejecución
// ?set=dev lee _test/dev/manifest.json (archivos sintéticos) en lugar de _test/manifest.json.
const SET = (new URLSearchParams(location.search).get("set") || "").replace(/[^\w-]/g, "");
const BASE = SET ? `/_test/${SET}/` : "/_test/";

async function fetchOk(url, as) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return as === "text" ? res.text() : res.arrayBuffer();
}

// Diff por líneas (LCS). Para archivos enormes se limita a la primera diferencia.
function lineDiff(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 2e7) {
    const i = x.findIndex((line, n) => line !== y[n]);
    return [{ op: "-", text: x[i] ?? "" }, { op: "+", text: y[i] ?? "" }];
  }
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push({ op: " ", text: x[i] }); i++; j++; }
    else if (j < y.length && (i === x.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) { out.push({ op: "+", text: y[j] }); j++; }
    else { out.push({ op: "-", text: x[i] }); i++; }
  }
  return out;
}

// Solo los cambios con dos líneas de contexto.
function diffText(diff) {
  const keep = diff.map((d, i) => d.op !== " " || diff.slice(Math.max(0, i - 2), i + 3).some((n) => n.op !== " "));
  return diff.filter((_, i) => keep[i]).map((d) => `${d.op} ${d.text}`).join("\n");
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function runCase(c, defaults) {
  const started = performance.now();
  const row = { name: c.file, format: c.format || "", ok: false, message: "", output: "", diff: "", warnings: [] };
  const buffer = await fetchOk(BASE + c.file);
  if (!buffer) return { ...row, message: "Missing test file" };
  try {
    row.format = c.format || (await detectFormat(new Uint8Array(buffer), c.file)).format;
    const opts = { ...defaults, ...c.options, date: FIXED_DATE };
    const result = await convertDocument(buffer, row.format, opts);
    row.warnings = result.warnings;
    row.images = result.images.length;
    row.output = finalizeMarkdown(result, c.file, opts);
    if (c.expectError) return { ...row, time: performance.now() - started, message: "Expected an error, got output" };
  } catch (e) {
    row.time = performance.now() - started;
    if (c.expectError) return { ...row, ok: true, message: `Error as expected: ${e.message}` };
    return { ...row, message: `Error: ${e.message}` };
  }
  row.time = performance.now() - started;

  const missing = (c.expectWarnings || []).filter((w) => !row.warnings.some((have) => have.includes(w)));
  const expected = c.expected ? await fetchOk(BASE + c.expected, "text") : null;
  if (expected === null) return { ...row, message: "No expected file yet: download the output, review it and save it as expected" };
  const same = expected.replace(/\r\n?/g, "\n") === row.output;
  row.diff = same ? "" : diffText(lineDiff(expected.replace(/\r\n?/g, "\n"), row.output));
  const badImages = c.expectImages !== undefined && row.images !== c.expectImages;
  row.ok = same && !missing.length && !badImages;
  row.message = [same ? "Matches expected" : "Differs from expected", missing.length ? `missing warnings: ${missing.join(", ")}` : "", badImages ? `${row.images} images, expected ${c.expectImages}` : ""].filter(Boolean).join(" · ");
  return row;
}

function renderRow(r, c) {
  const tr = document.createElement("tr");
  const cells = [r.name, r.format, `${Math.round(r.time || 0)} ms`].map((t, i) => {
    const td = document.createElement("td");
    td.textContent = t;
    if (i === 1) td.className = "dim";
    if (i === 2) td.className = "num";
    return td;
  });
  const result = document.createElement("td");
  const msg = document.createElement("span");
  msg.className = r.ok ? "ok" : "err";
  msg.textContent = `${r.ok ? "OK" : "FAIL"} · ${r.message}`;
  result.append(msg);
  if (r.warnings.length) {
    const ul = document.createElement("ul");
    ul.className = "warns";
    ul.append(...r.warnings.map((w) => Object.assign(document.createElement("li"), { textContent: w })));
    result.append(ul);
  }
  if (r.diff) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Diff (- expected, + output)";
    const pre = document.createElement("pre");
    pre.className = "md-source";
    pre.textContent = r.diff;
    details.append(summary, pre);
    result.append(details);
  }
  const actions = document.createElement("td");
  actions.className = "num";
  if (r.output) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = "↓ output";
    b.addEventListener("click", () => download(r.output, c.expected || `${c.file}.expected.md`));
    actions.append(b);
  }
  tr.append(...cells, result, actions);
  return tr;
}

async function runAll() {
  $("run").disabled = true;
  const tbody = $("results").tBodies[0];
  tbody.replaceChildren();
  $("results").hidden = false;
  let manifest;
  try {
    manifest = JSON.parse(await fetchOk(`${BASE}manifest.json`, "text"));
  } catch (e) {
    $("summary").textContent = `Couldn't read ${BASE}manifest.json.`;
    $("run").disabled = false;
    return;
  }
  let passed = 0;
  for (const [i, c] of manifest.cases.entries()) {
    $("summary").textContent = `Running ${i + 1} of ${manifest.cases.length}: ${c.file}`;
    const r = await runCase(c, manifest.defaults || {});
    if (r.ok) passed++;
    tbody.append(renderRow(r, c));
  }
  $("summary").textContent = `${passed} of ${manifest.cases.length} passed.`;
  $("run").disabled = false;
}

$("run").addEventListener("click", runAll);
if (new URLSearchParams(location.search).has("run")) runAll();
