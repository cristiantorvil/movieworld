// Regenera elo/index.html (Cine Elo + Watchlist) desde el código fuente:
//   cd elo/frontend/build && npm install && node build.mjs
// Copia ../cine-elo.jsx acá al lado (entry.jsx lo importa desde esta
// carpeta), bundlea con esbuild y mete el resultado inline en el HTML —
// una sola página autocontenida, como siempre.
import { build } from "esbuild";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(here, "..", "cine-elo.jsx"), join(here, "cine-elo.jsx"));

const result = await build({
  entryPoints: [join(here, "entry.jsx")],
  bundle: true,
  minify: true,
  write: false,
  loader: { ".js": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const icon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%AC%3C/text%3E%3C/svg%3E";
const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cine Elo</title>
<link rel="icon" href="${icon}" />
<style>
  html, body { margin:0; padding:0; background:#101116; }
  #root { min-height:100vh; }
</style>
</head>
<body>
<div id="root"></div>
<script>
${js}
</script>
</body>
</html>
`;
const out = join(here, "..", "..", "index.html");
const before = readFileSync(out, "utf8");
writeFileSync(out, html);
console.log(`elo/index.html: ${before.length} -> ${html.length} bytes`);
