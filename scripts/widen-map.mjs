// Widen the car roads of the map in the repository (src/shared/world/widen.ts: as far as each street
// has room) and bake the lanes and walking lines again for the new widths, without rebuilding the map
// from OpenStreetMap. Once: a map that says it's been widened (`wide`) is left as it is. The map
// builder (build-map.mjs) does the same to every map it builds.
//
//   node scripts/widen-map.mjs [map.json]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../public/data/bratislava.json', import.meta.url);
const { build } = await import('esbuild');
const out = await build({
  stdin: { contents: "export { World } from './src/shared/world/World'; export { widenRoads } from './src/shared/world/widen';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'warning',
});
const { World, widenRoads } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const map = JSON.parse(await readFile(FILE, 'utf8'));
if (map.wide) {
  console.log(`${fileURLToPath(FILE)}: already widened (×${map.wide} at most)`);
  process.exit(0);
}
const t = performance.now();
const before = map.roads.map((r) => r.w);
const n = widenRoads(map, new World(map));
// the lanes and walking lines, fitted to the new widths (as the map builder bakes them)
for (const e of map.graph.car.edges) delete e.lf, delete e.lr, delete e.bf, delete e.br;
for (const e of map.graph.ped.edges) delete e.wr, delete e.wl, delete e.nw;
delete map.fit;
new World(map).bakeFits(map);
const gain = map.roads.reduce((s, r, i) => s + (r.w - before[i]), 0) / Math.max(1, n);
console.log(`widened ${n} of ${map.roads.filter((r) => r.c <= 7 && !r.b).length} car roads (by ${gain.toFixed(1)} m on average) in ${Math.round(performance.now() - t)} ms`);
await writeFile(FILE, JSON.stringify(map));
