// Utilidades compartidas por los conversores de paquetes ZIP con XML (PPTX, ODT, ODP).
// Los conversores la cargan en su load(); va aparte para no declarar dos veces los mismos nombres.

const loadZipXml = () => loadScript(JSZIP_SRC);

const xmlKids = (el, ns, name) => (el ? [...el.children].filter((c) => c.namespaceURI === ns && (!name || c.localName === name)) : []);
const xmlKid = (el, ns, name) => xmlKids(el, ns, name)[0] || null;
const xmlPath = (el, ...steps) => steps.reduce((node, [ns, name]) => xmlKid(node, ns, name), el);

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This document contains damaged XML");
  return doc;
}

async function readXml(zip, name) {
  const file = zip.file(name);
  return file ? parseXml(await file.async("string")) : null;
}

async function readZipBytes(zip, name) {
  const file = zip.file(name);
  return file ? file.async("uint8array") : null;
}

// Título de las propiedades del documento (OOXML: docProps/core.xml; ODF: meta.xml).
async function packageTitle(zip) {
  for (const name of ["docProps/core.xml", "meta.xml"]) {
    const doc = await readXml(zip, name);
    const el = doc && doc.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")[0];
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return "";
}
