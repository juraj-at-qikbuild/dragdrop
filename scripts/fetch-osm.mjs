// Downloads raw OpenStreetMap data for the playable Bratislava area from the
// OSM editing API in small tiles (the API rejects large bounding boxes).
// Output: .cache/osm/<minLon>_<minLat>_<maxLon>_<maxLat>.osm  (raw XML, not committed)
import { mkdir, writeFile, access } from 'node:fs/promises';

import { tiles } from './bbox.mjs';
const OUT = new URL('../.cache/osm/', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile({ bbox, file: name }) {
  const file = new URL(name, OUT);
  try {
    await access(file);
    return 'cached';
  } catch {}
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'gta-bratislava-map-builder/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(file, await res.text());
      return 'ok';
    } catch (err) {
      console.warn(`  retry ${bbox}: ${err.message}`);
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw new Error(`failed tile ${bbox}`);
}

await mkdir(OUT, { recursive: true });
const all = tiles();
let done = 0;
const queue = [...all];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const t = queue.shift();
      const status = await fetchTile(t);
      console.log(`[${++done}/${all.length}] ${t.bbox} ${status}`);
    }
  }),
);
console.log('OSM download complete');
