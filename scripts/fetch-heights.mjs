// Downloads the number of floors of the buildings in the playable area from Bratislava's
// digital technical map (label points with floors above/below ground), used by build-map.mjs
// for the buildings OpenStreetMap has no height for.
// Source: Hlavné mesto SR Bratislava, geoportal.bratislava.sk, service tm/Stavby, layer 4
// ("Podlažnosť"), licence CC BY 4.0. Attribution: "Digitálna technická mapa hlavného mesta SR
// Bratislavy (©) Hlavné mesto SR Bratislava".
// Output: .cache/heights/floors.geojson (not committed). Failing is not fatal: the map then
// keeps its estimated heights.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { BBOX } from './bbox.mjs';

const OUT = new URL('../.cache/heights/floors.geojson', import.meta.url);
const SERVICE = 'https://geoportal.bratislava.sk/hSite/rest/services/tm/Stavby/MapServer/4/query';
const PAGE = 2000;

try {
  await access(OUT);
  console.log('floors: cached');
  process.exit(0);
} catch {}

const query = (extra) =>
  `${SERVICE}?${new URLSearchParams({
    where: '1=1',
    geometry: `${BBOX.minLon},${BBOX.minLat},${BBOX.maxLon},${BBOX.maxLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,podaznost_plus,podlaznost_minus',
    outSR: '4326',
    orderByFields: 'OBJECTID ASC',
    resultRecordCount: String(PAGE),
    f: 'geojson',
    ...extra,
  })}`;

// the server turns away requests without a browser- or curl-like user agent
const headers = { 'User-Agent': 'curl/8.5.0', Accept: '*/*' };
const features = [];
try {
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(query({ resultOffset: String(offset) }), { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = await res.json();
    const fs = page.features ?? [];
    features.push(...fs);
    console.log(`floors: ${features.length} points`);
    if (fs.length < PAGE && !(page.exceededTransferLimit || page.properties?.exceededTransferLimit)) break;
  }
} catch (err) {
  console.warn(`floors: download failed (${err.message}); building heights stay estimated`);
  process.exit(0);
}
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ type: 'FeatureCollection', attribution: 'Digitálna technická mapa hlavného mesta SR Bratislavy (©) Hlavné mesto SR Bratislava, CC BY 4.0', features }));
console.log(`floors: wrote ${features.length} points`);
