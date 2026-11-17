// Rellena la plantilla con ?name= y ajusta el tamaño del título a la longitud del nombre.
// ?viewer muestra «Markdown Viewer» en lugar de «X → Markdown».
const params = new URLSearchParams(location.search);
const name = params.get("name") || "Documents";
const h1 = document.querySelector("h1");
if (params.has("viewer")) {
  h1.replaceChildren("Markdown", document.createElement("br"), "Viewer");
} else {
  document.getElementById("name").textContent = name;
  h1.classList.toggle("long", name.length > 9 && name.length <= 14);
  h1.classList.toggle("xlong", name.length > 14);
}
document.fonts.ready.then(() => document.body.classList.add("ready"));
