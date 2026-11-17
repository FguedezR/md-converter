// Texto plano: se respeta tal cual (suele ser ya Markdown legible); solo se decodifica bien.
registerConverter({
  id: "txt",
  label: "Plain text",
  extensions: ["txt"],
  convert: async (buffer) => {
    const { text, encoding } = decodeText(new Uint8Array(buffer));
    const warnings = encoding === "windows-1252" ? ["Not valid UTF-8: decoded as Windows-1252"] : [];
    return { markdown: text, warnings, images: [] };
  },
});
