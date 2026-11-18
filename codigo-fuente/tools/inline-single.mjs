// Genera Jugar.html (archivo unico, funciona con doble clic) a partir de dist/.
// Uso: npm run build:single
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
let html = readFileSync(join(dist, 'index.html'), 'utf8');

// CSS: incrusta las fuentes woff2 como data URI y descarta los respaldos .woff.
const cssMatch = html.match(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/);
let css = readFileSync(join(dist, cssMatch[1]), 'utf8');
css = css.replace(/,\s*url\(\.\/[^)]+\.woff\)\s*format\("woff"\)/g, '');
css = css.replace(/url\(\.\/([^)]+\.woff2)\)/g, (_, f) => {
  const p = join(dist, 'assets', f);
  return existsSync(p) ? `url(data:font/woff2;base64,${readFileSync(p).toString('base64')})` : `url(./${f})`;
});
html = html.replace(cssMatch[0], () => `<style>\n${css}\n</style>`);

// JS: modulo en linea (se escapa </script para no cerrar la etiqueta).
const jsMatch = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/);
const js = readFileSync(join(dist, jsMatch[1]), 'utf8').replace(/<\/script/gi, '<\\/script');
html = html.replace(jsMatch[0], () => '');
html = html.replace('</body>', () => `<script type="module">\n${js}\n</script>\n</body>`);

const out = join(root, '..', 'Jugar.html');
writeFileSync(out, html);
console.log(`Jugar.html generado (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
