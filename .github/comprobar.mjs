// Comprobación automática en cada subida: que el código se pueda ejecutar
// y que la versión sea la misma en app.js, sw.js y version.json (si no, el aviso de «versión nueva» falla).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
let fallos = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fallos++; };
for (const f of ['app.js', 'sw.js']) {
  try { new vm.Script(readFileSync(f, 'utf8'), { filename: f }); ok(true, `${f} sin errores de sintaxis`); }
  catch (e) { ok(false, `${f}: ${e.message}`); }
}
const v1 = /const VERSION = '(v\d+)'/.exec(readFileSync('app.js', 'utf8'))?.[1];
const v2 = /mis-pedidos-(v\d+)/.exec(readFileSync('sw.js', 'utf8'))?.[1];
const v3 = JSON.parse(readFileSync('version.json', 'utf8')).v;
ok(v1 && v1 === v2 && v2 === v3, `misma versión en app.js (${v1}), sw.js (${v2}) y version.json (${v3})`);
const html = readFileSync('index.html', 'utf8');
for (const f of ['estilos.css', 'app.js']) ok(html.includes(f), `index.html carga ${f}`);
const sw = readFileSync('sw.js', 'utf8');
for (const f of ['index.html', 'estilos.css', 'app.js', 'figtree.woff2']) ok(sw.includes(`'${f}'`), `sw.js guarda ${f} para usarla sin conexión`);
process.exit(fallos ? 1 : 0);
