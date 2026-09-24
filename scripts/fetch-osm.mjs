// Downloads raw OpenStreetMap data for the playable Bratislava area from the
// OSM editing API in small tiles (the API rejects large bounding boxes).
// Output: .cache/osm/<lon>_<lat>.osm  (raw XML, not committed)
import { mkdir, writeFile, access } from 'node:fs/promises';

import { BBOX } from './bbox.mjs';
const STEP = 0.005;
const OUT = new URL('../.cache/osm/', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(lon, lat) {
  const file = new URL(`${lon.toFixed(3)}_${lat.toFixed(3)}.osm`, OUT);
  try {
    await access(file);
    return 'cached';
  } catch {}
  const bbox = [lon, lat, Math.min(lon + STEP, BBOX.maxLon), Math.min(lat + STEP, BBOX.maxLat)]
    .map((v) => v.toFixed(4))
    .join(',');
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
const tiles = [];
for (let lon = BBOX.minLon; lon < BBOX.maxLon - 1e-9; lon += STEP)
  for (let lat = BBOX.minLat; lat < BBOX.maxLat - 1e-9; lat += STEP) tiles.push([lon, lat]);

let done = 0;
const queue = [...tiles];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const [lon, lat] = queue.shift();
      const status = await fetchTile(lon, lat);
      console.log(`[${++done}/${tiles.length}] ${lon.toFixed(3)},${lat.toFixed(3)} ${status}`);
    }
  }),
);
console.log('OSM download complete');
