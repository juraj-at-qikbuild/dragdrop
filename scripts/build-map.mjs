// Converts the raw OSM tiles in .cache/osm into a compact game map:
// public/data/bratislava.json  (all coordinates in metres, origin at map centre,
// +x = east, +y = south). MAP_OUT=<path> writes somewhere else (for comparisons).
//
// Besides streets and buildings it keeps what makes the city physically "real" in the game:
// which structures float above the ground (the UFO on Most SNP, skywalks), passages through
// buildings (Michalská brána, Leopoldova brána, courtyard gateways, covered roads), the public
// road and tram tunnels, walls/fences/hedges with their real gaps, piers over the water, and
// real trees, street lamps, zebra crossings, traffic lights, tram stops, railways and speed limits.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { BBOX } from './bbox.mjs';

const SRC = new URL('../.cache/osm/', import.meta.url);
const OUT = process.env.MAP_OUT ? new URL(process.env.MAP_OUT, `file://${process.cwd()}/`) : new URL('../public/data/bratislava.json', import.meta.url);

// ---------------------------------------------------------------- parsing
const nodes = new Map(); // id -> {lat, lon, tags}
const ways = new Map(); // id -> {nds, tags}
const rels = new Map(); // id -> {members, tags}

const ATTR = /(\w+)="([^"]*)"/g;
const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const attrs = (line) => {
  const o = {};
  for (const m of line.matchAll(ATTR)) o[m[1]] = m[2];
  return o;
};

function parse(xml) {
  let cur = null;
  for (const raw of xml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('<node ')) {
      const a = attrs(line);
      cur = { lat: +a.lat, lon: +a.lon, tags: {} };
      if (!nodes.has(a.id)) nodes.set(a.id, cur);
      else cur = nodes.get(a.id);
      if (line.endsWith('/>')) cur = null;
    } else if (line.startsWith('<way ')) {
      const a = attrs(line);
      cur = ways.has(a.id) ? null : { nds: [], tags: {} };
      if (cur) ways.set(a.id, cur);
    } else if (line.startsWith('<relation ')) {
      const a = attrs(line);
      cur = rels.has(a.id) ? { members: [], tags: {}, dup: rels.get(a.id) } : { members: [], tags: {} };
      if (!cur.dup) rels.set(a.id, cur);
    } else if (!cur) continue;
    else if (line.startsWith('<nd ')) cur.nds.push(attrs(line).ref);
    else if (line.startsWith('<member ')) {
      const a = attrs(line);
      const target = cur.dup ?? cur;
      if (!target.members.some((m) => m.ref === a.ref && m.type === a.type)) target.members.push(a);
    } else if (line.startsWith('<tag ')) {
      const a = attrs(line);
      if (!cur.dup) cur.tags[decode(a.k)] = decode(a.v);
    } else if (line.startsWith('</')) cur = null;
  }
}

const files = (await readdir(SRC)).filter((f) => f.endsWith('.osm'));
for (const f of files) parse(await readFile(new URL(f, SRC), 'utf8'));
console.log(`parsed ${files.length} tiles: ${nodes.size} nodes, ${ways.size} ways, ${rels.size} relations`);

// ------------------------------------------------------------- projection
const LAT0 = (BBOX.minLat + BBOX.maxLat) / 2;
const LON0 = (BBOX.minLon + BBOX.maxLon) / 2;
const KX = Math.cos((LAT0 * Math.PI) / 180) * 111320;
const KY = 110574;
const project = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
const [minX, maxY] = project(BBOX.minLat, BBOX.minLon);
const [maxX, minY] = project(BBOX.maxLat, BBOX.maxLon);
const MARGIN = 150;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const nodeXY = new Map();
const xy = (id) => {
  let p = nodeXY.get(id);
  if (!p) {
    const n = nodes.get(id);
    if (!n) return null;
    p = project(n.lat, n.lon);
    nodeXY.set(id, p);
  }
  return p;
};
const wayPts = (w) => w.nds.map(xy).filter(Boolean);

function inView(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return x1 > minX - MARGIN && x0 < maxX + MARGIN && y1 > minY - MARGIN && y0 < maxY + MARGIN;
}
const inBounds = (x, y, m = 0) => x > minX - m && x < maxX + m && y > minY - m && y < maxY + m;

// Douglas-Peucker
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let best = -1, bestD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > bestD) (bestD = d), (best = i);
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
const flat = (pts) => pts.flatMap(([x, y]) => [r1(x), r1(y)]);
const polyArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
};
const flatArea = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j] + r[i]) * (r[j + 1] - r[i + 1]);
  return Math.abs(a / 2);
};
const centroid = (pts) => {
  let x = 0, y = 0;
  for (const p of pts) (x += p[0]), (y += p[1]);
  return [x / pts.length, y / pts.length];
};
/** even-odd point in polygon over flat [x,y,...] rings */
function pointInRings(x, y, rings) {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}
/** segment-segment intersection: t along the first segment, or -1 */
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den === 0) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}
/** cumulative arc lengths of a point list */
function cumLen(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}
function pointAt(pts, cum, s) {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1e-9;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / seg));
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}
/** the part of a polyline between arc lengths s0 and s1 */
function subPolyline(pts, cum, s0, s1) {
  const out = [pointAt(pts, cum, s0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
  out.push(pointAt(pts, cum, s1));
  return out;
}

/** Uniform grid over bounding boxes; query() visits each item once. */
class Grid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
    this.stamp = 0;
  }
  add(item, x0, y0, x1, y1) {
    item._stamp = 0;
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++)
      for (let gy = Math.floor(y0 / this.cell); gy <= Math.floor(y1 / this.cell); gy++) {
        const k = gx * 100000 + gy;
        let c = this.map.get(k);
        if (!c) this.map.set(k, (c = []));
        c.push(item);
      }
  }
  query(x0, y0, x1, y1, fn) {
    const s = ++this.stamp;
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++)
      for (let gy = Math.floor(y0 / this.cell); gy <= Math.floor(y1 / this.cell); gy++) {
        const c = this.map.get(gx * 100000 + gy);
        if (!c) continue;
        for (const it of c) {
          if (it._stamp === s) continue;
          it._stamp = s;
          fn(it);
        }
      }
  }
}

// ------------------------------------------------------ multipolygon rings
function assembleRings(wayIds) {
  const chains = wayIds.map((id) => ways.get(id)).filter(Boolean).map((w) => w.nds.filter((n) => nodes.has(n)));
  const rings = [];
  const open = [];
  for (const c of chains) {
    if (c.length < 2) continue;
    if (c[0] === c[c.length - 1]) rings.push(c);
    else open.push([...c]);
  }
  // join chains that share endpoints
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < open.length && !merged; i++) {
      for (let j = 0; j < open.length && !merged; j++) {
        if (i === j) continue;
        const a = open[i], b = open[j];
        let joined = null;
        if (a[a.length - 1] === b[0]) joined = a.concat(b.slice(1));
        else if (a[a.length - 1] === b[b.length - 1]) joined = a.concat(b.slice(0, -1).reverse());
        else if (a[0] === b[b.length - 1]) joined = b.concat(a.slice(1));
        else if (a[0] === b[0]) joined = b.slice().reverse().concat(a.slice(1));
        if (joined) {
          open.splice(Math.max(i, j), 1);
          open.splice(Math.min(i, j), 1);
          if (joined[0] === joined[joined.length - 1]) rings.push(joined);
          else open.push(joined);
          merged = true;
        }
      }
    }
  }
  const out = rings.map((r) => r.map(xy));
  // Chains cut by the download area (e.g. the Danube banks): greedily connect
  // each chain's end to the nearest remaining chain start to form a ring.
  if (open.length) {
    const segs = open.map((c) => c.map(xy));
    while (segs.length) {
      let ring = segs.shift();
      while (segs.length) {
        const end = ring[ring.length - 1];
        let best = -1, bestD = Infinity, rev = false;
        segs.forEach((s, i) => {
          const d0 = Math.hypot(s[0][0] - end[0], s[0][1] - end[1]);
          const d1 = Math.hypot(s[s.length - 1][0] - end[0], s[s.length - 1][1] - end[1]);
          if (d0 < bestD) (bestD = d0), (best = i), (rev = false);
          if (d1 < bestD) (bestD = d1), (best = i), (rev = true);
        });
        const s = segs.splice(best, 1)[0];
        ring = ring.concat(rev ? s.reverse() : s);
      }
      out.push(ring);
    }
  }
  return out;
}

// ---------------------------------------------------------------- output
const names = [];
const nameIdx = new Map();
const nameId = (n) => {
  if (!n) return -1;
  if (!nameIdx.has(n)) nameIdx.set(n, names.push(n) - 1);
  return nameIdx.get(n);
};

const ROAD_CLASS = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 5,
  motorway_link: 1, trunk_link: 1, primary_link: 2, secondary_link: 3, tertiary_link: 4,
  living_street: 6, service: 7, pedestrian: 8, footway: 9, path: 9, cycleway: 9, steps: 10, track: 7,
};
const DEFAULT_WIDTH = [16, 13, 12, 10, 8.5, 7, 5.5, 4.5, 6, 2.5, 3];
const DRIVABLE = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const SPEED = [22, 18, 14, 13, 12, 10, 6, 6];

const roads = [];
const trams = [];
const buildings = [];
const areas = { water: [], green: [], wood: [], plaza: [], parking: [], pitch: [], sand: [], rail: [], pier: [] };
const pois = [];

function roadWidth(t, cls) {
  const w = parseFloat(t.width);
  if (w > 1 && w < 40) return w;
  const lanes = parseInt(t.lanes);
  if (lanes > 0 && cls <= 5) return Math.min(24, lanes * 3.3 + 1.5);
  return DEFAULT_WIDTH[cls];
}

/** Legal speed limit in m/s, or undefined (the class default applies). */
function maxspeed(t) {
  const v = t.maxspeed;
  if (!v) return undefined;
  const n = parseFloat(v);
  if (n > 0) return (v.includes('mph') ? n * 1.609 : n) / 3.6;
  const zone = { 'SK:urban': 50, 'SK:rural': 90, 'SK:trunk': 90, 'SK:motorway': 130, 'SK:living_street': 20, walk: 6 }[v];
  return zone ? zone / 3.6 : undefined;
}

function areaKind(t) {
  if (t.man_made === 'pier' && t.area !== 'no') return 'pier';
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'basin' || t.landuse === 'reservoir') return 'water';
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub') return 'wood';
  if (['park', 'garden', 'dog_park', 'playground'].includes(t.leisure) ||
      ['grass', 'meadow', 'village_green', 'recreation_ground', 'cemetery', 'allotments', 'orchard', 'vineyard'].includes(t.landuse) ||
      ['grassland', 'heath'].includes(t.natural)) return 'green';
  if (t.leisure === 'pitch' || t.leisure === 'track') return 'pitch';
  if (t.natural === 'beach' || t.natural === 'sand') return 'sand';
  if (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey') return 'parking';
  if ((t.highway === 'pedestrian' && t.area === 'yes') || t['area:highway'] || t.place === 'square' || t.amenity === 'marketplace') return 'plaza';
  if (t.landuse === 'railway') return 'rail';
  return null;
}

/** metres per storey (must match BuildingGeometry.STOREY) */
const STOREY = 3.2;

function buildingInfo(t) {
  let levels = parseFloat(t['building:levels']);
  const h = parseFloat(t.height);
  const small = ['garage', 'garages', 'shed', 'kiosk', 'roof', 'hut'].includes(t.building);
  // no height at all: default to 3 storeys and flag it, so the game can vary untagged heights
  const untagged = !(levels > 0) && !(h > 0) && !small;
  if (!(levels > 0)) levels = h > 0 ? h / STOREY : small ? 1 : 3;
  let kind = 0; // 0 normal, 1 church, 2 castle/landmark, 3 industrial, 4 roof/shelter, 5 tower structure drawn by the game
  if (['church', 'cathedral', 'chapel'].includes(t.building) || t.amenity === 'place_of_worship') kind = 1;
  if (t.historic === 'castle' || t.building === 'castle' || t.historic === 'city_gate') kind = 2;
  if (['industrial', 'warehouse', 'retail', 'commercial'].includes(t.building)) kind = 3;
  if (['roof', 'canopy', 'carport'].includes(t.building)) kind = 4;
  // the Most SNP pylon legs and the UFO restaurant on top of them (building=bridge + man_made=tower)
  if (t.building === 'bridge' && t.man_made === 'tower') kind = 5;
  levels = Math.min(40, Math.max(1, levels));
  // raised structures: the part of the building that starts above the ground (min_height,
  // building:min_level). Nothing stands under it at street level (the UFO, skywalks, arcades).
  let minH = parseFloat(t.min_height);
  if (!(minH > 0)) {
    const ml = parseFloat(t['building:min_level']);
    minH = ml > 0 ? ml * STOREY : 0;
  }
  if (minH >= levels * STOREY - 0.5) minH = 0;
  return { levels, kind, untagged, minH };
}

function addBuilding(rings, t, id) {
  if (t.building === 'no' || t['building:part'] || t.location === 'underground' || t.layer < 0) return;
  const rs = rings.map((r) => simplify(r, 0.25)).filter((r) => r.length >= 4);
  if (!rs.length || !inView(rs[0])) return;
  const { levels, kind, untagged, minH } = buildingInfo(t);
  const b = { r: rs.map(flat), l: Math.round(levels * 10) / 10, k: kind, s: id % 997 };
  if (untagged) b.u = 1;
  if (minH >= 2) b.m = r1(minH);
  if (t.name) b.n = nameId(t.name);
  buildings.push(b);
}

function addArea(kind, rings) {
  const rs = rings.map((r) => simplify(r, kind === 'pier' ? 0.2 : 0.8)).filter((r) => r.length >= 4 && inView(r));
  if (!rs.length) return;
  areas[kind].push(rs.map(flat));
}

/** A line of given width as a closed polygon (for linear piers). */
function bufferLine(pts, hw) {
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    left.push([pts[i][0] + nx * hw, pts[i][1] + ny * hw]);
    right.push([pts[i][0] - nx * hw, pts[i][1] - ny * hw]);
  }
  const ring = left.concat(right.reverse());
  ring.push(ring[0]);
  return ring;
}

// ------------------------------------------------------------ buildings + areas
for (const [id, w] of ways) {
  const t = w.tags;
  if (!Object.keys(t).length || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
  const pts = wayPts(w);
  if (pts.length < 4 || !inView(pts)) continue;
  if (t.building) addBuilding([pts], t, +id);
  const kind = areaKind(t);
  if (kind) addArea(kind, [pts]);
}
// linear piers and jetties (not closed): a walkable strip over the water
for (const w of ways.values()) {
  const t = w.tags;
  if (t.man_made !== 'pier' || w.nds[0] === w.nds[w.nds.length - 1]) continue;
  const pts = wayPts(w);
  if (pts.length < 2 || !inView(pts)) continue;
  const width = parseFloat(t.width) > 0.5 ? parseFloat(t.width) : 3;
  addArea('pier', [bufferLine(pts, width / 2)]);
}
// multipolygon relations
for (const [id, r] of rels) {
  const t = r.tags;
  if (t.type !== 'multipolygon') continue;
  const kind = areaKind(t);
  if (!t.building && !kind) continue;
  const outer = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref);
  const inner = r.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => m.ref);
  const outers = assembleRings(outer).filter((r) => r.length >= 4);
  if (!outers.length) continue;
  const inners = assembleRings(inner).filter((r) => r.length >= 4);
  const rings = [...outers, ...inners];
  if (t.building) addBuilding(rings, t, +id);
  if (kind) addArea(kind, rings);
}

// Buildings OSM has no height for often have 3D building:parts that do (towers, wings,
// the cathedral...): use their area-weighted height instead of a guess.
{
  const parts = [];
  for (const w of ways.values()) {
    const t = w.tags;
    if (!t['building:part'] || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
    const lv = parseFloat(t['building:levels']), h = parseFloat(t.height);
    const top = h > 0 ? h : lv > 0 ? lv * STOREY : 0;
    if (!(top > 0)) continue;
    const pts = wayPts(w);
    if (pts.length < 4) continue;
    const [cx, cy] = centroid(pts.slice(0, -1));
    parts.push({ cx, cy, area: polyArea(pts), top });
  }
  const grid = new Grid(64);
  for (const p of parts) grid.add(p, p.cx, p.cy, p.cx, p.cy);
  let fixed = 0;
  for (const b of buildings) {
    if (!b.u) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const r = b.r[0];
    for (let i = 0; i < r.length; i += 2) (x0 = Math.min(x0, r[i])), (x1 = Math.max(x1, r[i])), (y0 = Math.min(y0, r[i + 1])), (y1 = Math.max(y1, r[i + 1]));
    let wsum = 0, hsum = 0;
    grid.query(x0, y0, x1, y1, (p) => {
      if (!pointInRings(p.cx, p.cy, b.r)) return;
      wsum += p.area;
      hsum += p.area * p.top;
    });
    if (wsum > 0) {
      b.l = Math.round(Math.min(40, Math.max(1, hsum / wsum / STOREY)) * 10) / 10;
      delete b.u;
      fixed++;
    }
  }
  console.log(`building:part heights applied to ${fixed} buildings`);
}

// ...and the rest from Bratislava's digital technical map: floors above ground at the label
// points of its buildings (scripts/fetch-heights.mjs; CC BY 4.0, © Hlavné mesto SR Bratislava).
// A building takes the median of the labels inside its footprint.
try {
  const floors = JSON.parse(await readFile(new URL('../.cache/heights/floors.geojson', import.meta.url), 'utf8'));
  const grid = new Grid(32);
  for (const f of floors.features) {
    const n = f.properties?.podaznost_plus;
    const c = f.geometry?.coordinates;
    if (!(n > 0) || !c) continue;
    const [x, y] = project(c[1], c[0]);
    grid.add({ x, y, n }, x, y, x, y);
  }
  let fixed = 0, still = 0;
  for (const b of buildings) {
    if (!b.u) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const r = b.r[0];
    for (let i = 0; i < r.length; i += 2) (x0 = Math.min(x0, r[i])), (x1 = Math.max(x1, r[i])), (y0 = Math.min(y0, r[i + 1])), (y1 = Math.max(y1, r[i + 1]));
    const found = [];
    grid.query(x0, y0, x1, y1, (p) => pointInRings(p.x, p.y, b.r) && found.push(p.n));
    if (!found.length) {
      still++;
      continue;
    }
    found.sort((a, b) => a - b);
    const m = found.length % 2 ? found[(found.length - 1) / 2] : (found[found.length / 2 - 1] + found[found.length / 2]) / 2;
    b.l = Math.min(40, Math.max(1, m));
    delete b.u;
    fixed++;
  }
  console.log(`technical-map floor counts applied to ${fixed} buildings (${still} still without a height)`);
} catch {
  console.log('no .cache/heights/floors.geojson (npm run fetch:heights): heights of untagged buildings stay estimated');
}

// Spatial index of the footprints the game treats as solid (see World: not a canopy, not a
// sliver, not raised off the ground).
const solidGrid = new Grid(32);
for (const b of buildings) {
  if (b.k === 4 || b.m || flatArea(b.r[0]) <= 6) continue;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of b.r) for (let i = 0; i < r.length; i += 2) (x0 = Math.min(x0, r[i])), (x1 = Math.max(x1, r[i])), (y0 = Math.min(y0, r[i + 1])), (y1 = Math.max(y1, r[i + 1]));
  solidGrid.add({ b, x0, y0, x1, y1 }, x0, y0, x1, y1);
}
const insideOf = (grid, x, y) => {
  let hit = null;
  grid.query(x, y, x, y, (s) => {
    if (!hit && x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1 && pointInRings(x, y, s.b.r)) hit = s;
  });
  return hit;
};
/** share of a polyline's length that lies inside footprints of `grid` */
function fracInside(pts, grid) {
  let inside = 0, total = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L));
    for (let k = 0; k < n; k++) {
      const tt = (k + 0.5) / n;
      if (insideOf(grid, ax + (bx - ax) * tt, ay + (by - ay) * tt)) inside += L / n;
    }
    total += L;
  }
  return total ? inside / total : 0;
}

// ---------------------------------------------------------------- ways by height
const TUNNEL = new Set(['yes', 'true', '1', 'avalanche_protector']);
/** Where a highway/railway runs relative to the street surface. */
function vertical(t) {
  const layer = parseFloat(t.layer) || 0;
  if (t.indoor === 'yes' || t.indoor === 'corridor' || t.highway === 'corridor') return 'indoor';
  // indoor levels (mall floors, garage decks); level 0 or a range through 0 is the street
  if (t.level !== undefined && !t.level.split(';').some((s) => parseFloat(s) === 0) && !(t.bridge && t.bridge !== 'no')) return 'indoor';
  if (t.location === 'underground') return 'underground';
  if (t.tunnel === 'building_passage') return layer <= -2 ? 'underground' : 'passage';
  if (TUNNEL.has(t.tunnel)) return 'tunnel';
  if (t.covered === 'yes' || t.covered === 'arcade' || t.covered === 'colonnade') return 'covered';
  if (layer < 0) return 'underground';
  return 'surface';
}

const graphWays = { car: [], ped: [], tram: [] };
/** surface highways the game keeps, for passages, barrier gaps, crossings and trees */
const kept = [];
/** tunnel tubes: public road tunnels and the tram tunnel under the castle hill */
const tunnels = [];
const tunnelWays = [];
const surfaceRoadNodes = new Set();
const surfaceTramNodes = new Set();
/** node id -> drivable ways through it (for crossings and traffic lights) */
const carWaysAt = new Map();
const stats = { indoor: 0, underground: 0, rooftop: 0, tunnel: 0 };

for (const [id, w] of ways) {
  const t = w.tags;
  if (!Object.keys(t).length) continue;
  const pts = wayPts(w);
  if (pts.length < 2 || !inView(pts)) continue;

  if (t.highway && ROAD_CLASS[t.highway] !== undefined && t.area !== 'yes') {
    const c = ROAD_CLASS[t.highway];
    let vert = vertical(t);
    // a street in a cutting mapped with only a negative layer is still a street
    if (vert === 'underground' && c <= 5 && !t.tunnel && t.location !== 'underground') vert = 'surface';
    const bridge = t.bridge && t.bridge !== 'no';
    const layer = parseFloat(t.layer) || 0;
    const width = r1(roadWidth(t, c));
    const drivable = DRIVABLE.has(c) && t.access !== 'no' && t.motor_vehicle !== 'no' && t.service !== 'parking_aisle' && t.service !== 'driveway';
    if (vert === 'indoor' || vert === 'underground') {
      stats[vert]++;
    } else if (vert === 'tunnel') {
      // only the public road tunnels (Suché mýto under Hodžovo námestie); garage ramps and
      // pedestrian underpasses stay off the map
      if (c <= 5 && drivable && t.access !== 'private') {
        tunnels.push({ p: flat(simplify(pts, 0.4)), w: width, k: 0, nds: [w.nds[0], w.nds[w.nds.length - 1]] });
        tunnelWays.push(w);
        graphWays.car.push({ w, c, oneway: t.oneway === 'yes' || t.oneway === '1' ? 1 : t.oneway === '-1' ? -1 : 0, width, name: t.name ? nameId(t.name) : -1, speed: maxspeed(t) });
        stats.tunnel++;
      } else stats.underground++;
    } else if (c >= 7 && layer > 0 && !bridge && fracInside(pts, solidGrid) > 0.5) {
      // paths and parking lanes on rooftops and decks on top of buildings (roof parks, parking
      // decks); real streets over a building built into the hillside keep a passage instead
      stats.rooftop++;
    } else {
      const road = { p: flat(simplify(pts, 0.4)), c, w: width };
      if (t.name) road.n = nameId(t.name);
      if (bridge) road.b = 1;
      if (t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout') road.o = 1;
      if (t.oneway === '-1') road.o = -1;
      if (+t.layer) road.y = +t.layer;
      roads.push(road);
      kept.push({ w, pts, c, width, bridge: !!bridge });
      for (const n of w.nds) surfaceRoadNodes.add(n);
      if (drivable) {
        graphWays.car.push({ w, c, oneway: road.o ?? 0, width: road.w, name: road.n ?? -1, speed: maxspeed(t) });
        if (!bridge)
          for (let i = 0; i < w.nds.length; i++) {
            let l = carWaysAt.get(w.nds[i]);
            if (!l) carWaysAt.set(w.nds[i], (l = []));
            l.push({ w, i, c, width: road.w });
          }
      }
      if (c >= 2 && t.foot !== 'no') graphWays.ped.push({ w, c, oneway: 0, width: road.w, name: road.n ?? -1 });
    }
  }
  if (t.railway === 'tram') {
    const vert = vertical(t);
    if (vert === 'tunnel') {
      tunnels.push({ p: flat(simplify(pts, 0.3)), w: 3.4, k: 1, nds: [w.nds[0], w.nds[w.nds.length - 1]] });
      tunnelWays.push(w);
      graphWays.tram.push({ w, c: 0, oneway: 0, width: 3, name: -1 });
    } else if (vert !== 'indoor' && vert !== 'underground') {
      trams.push(flat(simplify(pts, 0.3)));
      graphWays.tram.push({ w, c: 0, oneway: 0, width: 3, name: -1 });
      for (const n of w.nds) surfaceTramNodes.add(n);
    }
  }
}
// a tunnel end is a portal where it meets a surface street (or track); the others join more tunnel
for (const tu of tunnels) {
  const surf = tu.k === 1 ? surfaceTramNodes : surfaceRoadNodes;
  tu.o = tu.nds.map((n) => (surf.has(n) ? 1 : 0));
  delete tu.nds;
}
console.log(`ways dropped: ${stats.indoor} indoor, ${stats.underground} underground, ${stats.rooftop} on rooftops; ${tunnels.length} tunnel tubes`);

// ---------------------------------------------------------------- passages
// Streets and paths that pass through a solid footprint: gateways (Michalská brána, Leopoldova
// brána), courtyard passages, covered roads and arcades. The game cuts a corridor through the
// building's walls along them; untagged overlaps are cut too (the street is real, the wall isn't).
const passages = [];
{
  let tagged = 0, untagged = 0;
  for (const k of kept) {
    const pts = k.pts;
    const cum = cumLen(pts);
    const total = cum[cum.length - 1];
    if (total < 0.5) continue;
    const cuts = [0, total];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const segLen = cum[i] - cum[i - 1];
      solidGrid.query(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (s) => {
        for (const r of s.b.r)
          for (let j = 0; j < r.length - 2; j += 2) {
            const tt = segIntersect(ax, ay, bx, by, r[j], r[j + 1], r[j + 2], r[j + 3]);
            if (tt >= 0) cuts.push(cum[i - 1] + tt * segLen);
          }
      });
    }
    if (cuts.length === 2 && !insideOf(solidGrid, pts[0][0], pts[0][1])) continue;
    cuts.sort((a, b) => a - b);
    const inside = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const s0 = cuts[i], s1 = cuts[i + 1];
      if (s1 - s0 < 1e-3) continue;
      const [mx, my] = pointAt(pts, cum, (s0 + s1) / 2);
      if (!insideOf(solidGrid, mx, my)) continue;
      const last = inside[inside.length - 1];
      if (last && s0 - last[1] < 0.05) last[1] = s1;
      else inside.push([s0, s1]);
    }
    const t = k.w.tags;
    const isTagged = t.tunnel === 'building_passage' || t.covered === 'yes' || t.covered === 'arcade' || t.covered === 'colonnade';
    for (const [s0, s1] of inside) {
      if (s1 - s0 < 0.3) continue;
      const sub = subPolyline(pts, cum, Math.max(0, s0 - 0.8), Math.min(total, s1 + 0.8));
      const w = Math.min(12, Math.max(k.c >= 8 ? 3 : 3.4, k.width));
      passages.push({ p: flat(simplify(sub, 0.15)), w: r1(w) });
      if (isTagged) tagged++;
      else untagged++;
    }
  }
  console.log(`passages: ${passages.length} (${tagged} tagged as passage/covered, ${untagged} untagged crossings)`);
}

// ---------------------------------------------------------------- barriers
// Walls, fortifications, fences and hedges, cut open wherever a street or path goes through
// them (gates and entrances included), and wherever the line conflicts with a street's roadway.
/** 0 wall, 1 fortification (city/castle walls), 2 retaining wall, 3 fence, 4 hedge, 5 concrete barrier, 6 noise barrier, 7 flood wall */
function barrierKind(t) {
  const b = t.barrier;
  if (b === 'city_wall' || t.wall === 'castle_wall' || (b === 'wall' && (t.historic === 'citywalls' || t.historic === 'city_wall'))) return 1;
  if (b === 'retaining_wall') return 2;
  if (b === 'wall') return t.wall === 'noise_barrier' ? 6 : t.wall === 'flood_wall' ? 7 : 0;
  if (b === 'fence' || b === 'guard_rail') return 3;
  if (b === 'hedge') return 4;
  if (b === 'jersey_barrier' || b === 'block') return 5;
  return -1;
}
/** half-thickness per barrier kind (must match World.BARRIERS[].ht) */
const BARRIER_HT = [0.25, 0.9, 0.3, 0.06, 0.45, 0.3, 0.15, 0.25];
const GATES = new Set(['gate', 'entrance', 'lift_gate', 'swing_gate', 'wicket_gate', 'kissing_gate', 'turnstile', 'sliding_gate', 'hampshire_gate', 'stile', 'cattle_grid', 'full-height_turnstile', 'bump_gate', 'chain', 'cycle_barrier', 'bollard']);
const barriers = [];
{
  // surface street segments (bridges and tunnels don't cut ground-level walls)
  const segGrid = new Grid(16);
  for (const k of kept) {
    if (k.bridge) continue;
    for (let i = 1; i < k.pts.length; i++) {
      const [ax, ay] = k.pts[i - 1], [bx, by] = k.pts[i];
      const s = { ax, ay, bx, by, hw: k.width / 2 };
      segGrid.add(s, Math.min(ax, bx) - s.hw, Math.min(ay, by) - s.hw, Math.max(ax, bx) + s.hw, Math.max(ay, by) + s.hw);
    }
  }
  const keptNodes = new Set();
  for (const k of kept) if (!k.bridge) for (const n of k.w.nds) keptNodes.add(n);
  let total = 0, removed = 0;
  for (const w of ways.values()) {
    const t = w.tags;
    if (!t.barrier) continue;
    const kind = barrierKind(t);
    if (kind < 0) continue;
    const pts = wayPts(w);
    if (pts.length < 2 || !inView(pts)) continue;
    const cum = cumLen(pts);
    const L = cum[cum.length - 1];
    if (L < 0.5) continue;
    total += L;
    const gaps = [];
    // shared nodes with streets and paths, and gate nodes on the barrier
    for (let i = 0; i < w.nds.length; i++) {
      const nt = nodes.get(w.nds[i])?.tags ?? {};
      if (keptNodes.has(w.nds[i])) gaps.push([cum[i] - 1.7, cum[i] + 1.7]);
      else if (GATES.has(nt.barrier) || nt.entrance) gaps.push([cum[i] - 1.6, cum[i] + 1.6]);
    }
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const segLen = cum[i] - cum[i - 1];
      // streets crossing without a shared node
      segGrid.query(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (s) => {
        const tt = segIntersect(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by);
        if (tt < 0) return;
        // gap wide enough for the street (measured along the barrier), at least a car's width
        const ux = (bx - ax) / (segLen || 1), uy = (by - ay) / (segLen || 1);
        const sx = s.bx - s.ax, sy = s.by - s.ay, sl = Math.hypot(sx, sy) || 1;
        const sin = Math.abs(ux * (sy / sl) - uy * (sx / sl));
        const half = Math.min(8, Math.max(1.7, (s.hw + 0.4) / Math.max(0.35, sin)));
        const at = cum[i - 1] + tt * segLen;
        gaps.push([at - half, at + half]);
      });
      // stretches whose face reaches into a roadway or path (mapping overlaps): the street wins
      const ht = BARRIER_HT[kind];
      const n = Math.max(1, Math.ceil(segLen / 0.5));
      for (let k = 0; k < n; k++) {
        const s0 = cum[i - 1] + (k / n) * segLen, s1 = cum[i - 1] + ((k + 1) / n) * segLen;
        const mx = ax + (bx - ax) * ((k + 0.5) / n), my = ay + (by - ay) * ((k + 0.5) / n);
        let hitRoad = false;
        segGrid.query(mx - 2, my - 2, mx + 2, my + 2, (s) => {
          if (!hitRoad && segDist(mx, my, s.ax, s.ay, s.bx, s.by) < s.hw - 0.2 + ht) hitRoad = true;
        });
        if (hitRoad) gaps.push([s0, s1]);
      }
    }
    gaps.sort((a, b) => a[0] - b[0]);
    let s = 0;
    const pieces = [];
    for (const [g0, g1] of gaps) {
      if (g0 > s) pieces.push([s, g0]);
      s = Math.max(s, g1);
    }
    if (s < L) pieces.push([s, L]);
    for (const [s0, s1] of pieces) {
      if (s1 - s0 < 0.6) {
        removed += s1 - s0;
        continue;
      }
      barriers.push({ p: flat(simplify(subPolyline(pts, cum, s0, s1), 0.3)), k: kind });
    }
    removed += L - pieces.reduce((a, [s0, s1]) => a + (s1 - s0), 0);
  }
  console.log(`barriers: ${Math.round(total)} m, ${Math.round(removed)} m opened at streets and gates, ${barriers.length} pieces`);
}

// ------------------------------------------------------------ street features
/** real trees: single trees and tree rows (a tree every ~8 m) */
const trees = [];
for (const n of nodes.values()) {
  if (n.tags.natural !== 'tree') continue;
  const [x, y] = project(n.lat, n.lon);
  if (inBounds(x, y)) trees.push(r1(x), r1(y));
}
for (const w of ways.values()) {
  if (w.tags.natural !== 'tree_row') continue;
  const pts = wayPts(w);
  if (pts.length < 2 || !inView(pts)) continue;
  const cum = cumLen(pts);
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.round(L / 8));
  for (let i = 0; i <= n; i++) {
    const [x, y] = pointAt(pts, cum, n ? (L * i) / n : 0);
    if (inBounds(x, y)) trees.push(r1(x), r1(y));
  }
}
/** real street lamps */
const lamps = [];
for (const n of nodes.values()) {
  if (n.tags.highway !== 'street_lamp' && n.tags.man_made !== 'street_lamp') continue;
  const [x, y] = project(n.lat, n.lon);
  if (inBounds(x, y)) lamps.push(r1(x), r1(y));
}
/** direction (radians) of a way at its i-th node */
const wayAngle = (w, i) => {
  const a = xy(w.nds[Math.max(0, i - 1)]), b = xy(w.nds[Math.min(w.nds.length - 1, i + 1)]);
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
};
/** marked pedestrian crossings on drivable streets: x, y, street direction, street width */
const crossings = [];
/** traffic lights on drivable streets: x, y, street direction, applies to (0 both ways, 1 along, -1 against), 1 if a pedestrian crossing */
const signals = [];
for (const [id, n] of nodes) {
  const t = n.tags;
  const at = carWaysAt.get(id);
  if (!at) continue;
  const [x, y] = project(n.lat, n.lon);
  if (!inBounds(x, y)) continue;
  const main = at.reduce((a, b) => (b.c < a.c ? b : a));
  const ang = wayAngle(main.w, main.i);
  if (t.highway === 'crossing' || t.railway === 'crossing') {
    const marked = t['crossing:markings'] ? !['no', 'none'].includes(t['crossing:markings']) : ['zebra', 'marked', 'uncontrolled', 'traffic_signals'].includes(t.crossing) || t.crossing_ref === 'zebra';
    if (marked && main.c <= 7) crossings.push(r1(x), r1(y), r2(ang), r1(main.width));
  }
  const signalled = t.highway === 'traffic_signals' || (t.highway === 'crossing' && t.crossing === 'traffic_signals');
  if (signalled && t.traffic_signals !== 'emergency' && main.c <= 6) {
    const d = t['traffic_signals:direction'] ?? t.direction;
    signals.push(r1(x), r1(y), r2(ang), d === 'forward' ? 1 : d === 'backward' ? -1 : 0, t.highway === 'crossing' ? 1 : 0);
  }
}
/** tram stops (on the track) */
const tramStops = [];
for (const [id, n] of nodes) {
  const t = n.tags;
  if (!(t.railway === 'tram_stop' || (t.public_transport === 'stop_position' && t.tram === 'yes')) || !surfaceTramNodes.has(id)) continue;
  const [x, y] = project(n.lat, n.lon);
  if (!inBounds(x, y)) continue;
  let dup = false;
  for (let i = 0; i < tramStops.length; i += 2) if (Math.hypot(tramStops[i] - x, tramStops[i + 1] - y) < 6) dup = true;
  if (!dup) tramStops.push(r1(x), r1(y));
}
/** railway tracks (the Petržalka main line, the port sidings) */
const rails = [];
for (const w of ways.values()) {
  const t = w.tags;
  if (!['rail', 'light_rail', 'narrow_gauge'].includes(t.railway) || TUNNEL.has(t.tunnel)) continue;
  const pts = wayPts(w);
  if (pts.length < 2 || !inView(pts)) continue;
  const r = { p: flat(simplify(pts, 0.4)) };
  if (t.bridge && t.bridge !== 'no') r.b = 1;
  rails.push(r);
}
console.log(`features: ${trees.length / 2} trees, ${lamps.length / 2} lamps, ${crossings.length / 4} crossings, ${signals.length / 5} traffic lights, ${tramStops.length / 2} tram stops, ${rails.length} rail ways`);

// river centre-line as a fallback water body (width ~ 300 m for the Danube)
const rivers = [];
for (const w of ways.values()) {
  if (w.tags.waterway === 'river' && w.tags.name) {
    const pts = wayPts(w);
    if (pts.length > 1 && inView(pts)) rivers.push({ p: flat(simplify(pts, 2)), n: nameId(w.tags.name) });
  }
}

// ------------------------------------------------------------ road graphs
function buildGraph(list) {
  const use = new Map();
  for (const { w } of list) for (const n of w.nds) use.set(n, (use.get(n) ?? 0) + 1);
  const gNodes = [];
  const gIdx = new Map();
  const nodeOf = (n) => {
    if (!gIdx.has(n)) {
      const p = xy(n);
      gIdx.set(n, gNodes.length / 2);
      gNodes.push(r1(p[0]), r1(p[1]));
    }
    return gIdx.get(n);
  };
  const edges = [];
  for (const { w, c, oneway, width, name, speed } of list) {
    const nds = w.nds.filter((n) => nodes.has(n));
    let start = 0;
    for (let i = 1; i < nds.length; i++) {
      if (i === nds.length - 1 || use.get(nds[i]) > 1) {
        const seg = nds.slice(start, i + 1);
        const pts = simplify(seg.map(xy), 0.5);
        if (pts.length >= 2) {
          const e = { a: nodeOf(seg[0]), b: nodeOf(seg[seg.length - 1]), p: flat(pts), c, w: width };
          if (oneway) e.o = oneway;
          if (name >= 0) e.n = name;
          if (speed) e.s = r1(speed);
          if (e.a !== e.b) edges.push(e);
        }
        start = i;
      }
    }
  }
  return { nodes: gNodes, edges };
}

// ------------------------------------------------------------------- POIs
const PARODY = {
  Slovnaft: 'Slovnafta', OMV: 'OMW', Shell: 'Shel', MOL: 'MOLL', Orlen: 'Orlín',
  Billa: 'Billka', Lidl: 'Lidel', Tesco: 'Tescó', Kaufland: 'Kaufstrand', Kraj: 'Krajec', COOP: 'KOOP', 'COOP Jednota': 'Jednôtka',
  "McDonald's": "McDonaldov", KFC: 'KFČ', Starbucks: 'Starbáks', 'Burger King': 'Burger Kráľ', Subway: 'Subvej',
  dm: 'dn', Rossmann: 'Rossmanek', 'Tatra banka': 'Tatrabanka Gold', 'Slovenská sporiteľňa': 'Slovenská šporka',
  VÚB: 'VÚP', ČSOB: 'ČSOP', Primark: 'Primárik', Zara: 'Zára', 'H&M': 'H&N', 'Costa Coffee': 'Kosta Kafé',
  'Fresh': 'Freš', 'Yeme': 'Jeme', 'Terno': 'Terno Plus',
};
function parody(brand) {
  if (!brand) return null;
  if (PARODY[brand]) return PARODY[brand];
  return null;
}
function elemPos(type, el) {
  if (type === 'node') return project(el.lat, el.lon);
  if (type === 'way') {
    const pts = wayPts(el);
    return pts.length ? centroid(pts) : null;
  }
  return null;
}
const POI_KIND = (t) =>
  t.amenity === 'police' ? 'police' :
  t.amenity === 'hospital' || (t.healthcare === 'hospital') ? 'hospital' :
  t.amenity === 'fuel' ? 'fuel' :
  t.amenity === 'fast_food' || t.amenity === 'restaurant' || t.amenity === 'cafe' || t.amenity === 'bank' || t.shop ? 'shop' : null;

for (const [type, map] of [['node', nodes], ['way', ways]]) {
  for (const el of map.values()) {
    const t = el.tags;
    if (!t) continue;
    const kind = POI_KIND(t);
    if (!kind) continue;
    const brand = parody(t.brand) ?? parody(t.name);
    if (kind === 'shop' && !brand) continue;
    const p = elemPos(type, el);
    if (!p || !inView([p])) continue;
    pois.push({ k: kind, x: r1(p[0]), y: r1(p[1]), n: brand ?? (kind === 'fuel' ? 'Slovnafta' : t.name ?? '') });
  }
}

// ---------------------------------------------------------------- landmarks
const LANDMARKS = [
  ['castle', 'Bratislavský hrad', [/^Bratislavský hrad$/]],
  ['michael', 'Michalská brána', [/^Michalská brána$/, /^Michalská veža$/]],
  ['snp', 'Most SNP (UFO)', [/^UFO$/, /^Most SNP$/]],
  ['cathedral', 'Dóm sv. Martina', [/Dóm svätého Martina/, /Katedrála svätého Martina/, /Dóm sv\. Martina/]],
  ['primate', 'Primaciálny palác', [/^Primaciálny palác$/]],
  ['blue', 'Modrý kostolík', [/Kostol svätej Alžbety/, /Modrý kostol/]],
  ['eurovea', 'Eurovea', [/^Eurovea$/]],
  ['market', 'Stará tržnica', [/^Stará tržnica$/]],
  ['snd', 'Slovenské národné divadlo', [/Historická budova SND/, /^Slovenské národné divadlo$/]],
  ['cumil', 'Čumil', [/Čumil/]],
  ['main', 'Hlavné námestie', [/^Hlavné námestie$/]],
  ['president', 'Prezidentský palác', [/Grasalkovičov palác/, /Prezidentský palác/]],
  ['apollo', 'Most Apollo', [/^Most Apollo$/]],
  ['sad', 'Sad Janka Kráľa', [/^Sad Janka Kráľa$/]],
  ['oldbridge', 'Starý most', [/^Starý most$/]],
  ['hviezdoslav', 'Hviezdoslavovo námestie', [/^Hviezdoslavovo námestie$/]],
  ['reduta', 'Reduta', [/^Reduta$/]],
  ['sng', 'Slovenská národná galéria', [/^Slovenská národná galéria$/]],
  ['kamenne', 'Kamenné námestie', [/^Kamenné námestie$/]],
  ['aupark', 'Aupark', [/^Aupark$/]],
  ['slavin', 'Slavín', [/^Slavín$/]],
  ['parliament', 'Národná rada SR', [/Národná rada Slovenskej republiky/]],
];
const landmarks = [];
for (const [id, label, patterns] of LANDMARKS) {
  let found = null;
  outer: for (const re of patterns) {
    for (const [type, map] of [['way', ways], ['node', nodes], ['relation', rels]]) {
      for (const el of map.values()) {
        if (!el.tags?.name || !re.test(el.tags.name)) continue;
        let p = null;
        if (type === 'relation') {
          const outer = el.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref)).filter(Boolean);
          const pts = outer.flatMap(wayPts);
          if (pts.length) p = centroid(pts);
        } else p = elemPos(type, el);
        if (p && inView([p])) {
          found = p;
          break outer;
        }
      }
    }
  }
  if (found) landmarks.push({ id, n: label, x: r1(found[0]), y: r1(found[1]) });
  else console.warn(`landmark not found: ${label}`);
}

// Real-world colours for landmark buildings: [roof, walls]
const LANDMARK_STYLE = {
  castle: ['#b8553a', '#f3efe6'],
  blue: ['#5f9fd6', '#a9cde8'],
  primate: ['#a44a35', '#f2d4cf'],
  michael: ['#4f8a6e', '#f0ebe0'],
  cathedral: ['#59646c', '#d9d0bd'],
  snd: ['#6b7d8a', '#efe6cf'],
  president: ['#7b8a92', '#f2ecdc'],
  reduta: ['#6f7d86', '#f0e1c0'],
  market: ['#9a4b3a', '#e6d6b8'],
  eurovea: ['#c9ced2', '#8fa4b3'],
  parliament: ['#9aa3a8', '#e8e4da'],
  sng: ['#b0413e', '#e8e0d0'],
};
for (const l of landmarks) {
  const style = LANDMARK_STYLE[l.id];
  if (!style) continue;
  let best = null, bestScore = Infinity;
  for (const b of buildings) {
    if (b.k === 5) continue;
    const r = b.r[0];
    let cx = 0, cy = 0;
    for (let i = 0; i < r.length; i += 2) (cx += r[i]), (cy += r[i + 1]);
    cx /= r.length / 2;
    cy /= r.length / 2;
    const d = Math.hypot(cx - l.x, cy - l.y);
    const score = pointInRings(l.x, l.y, [r]) ? -flatArea(r) : d;
    if (score < bestScore && (score < 0 || d < 60)) (bestScore = score), (best = b);
  }
  if (best) {
    best.c = style[0];
    best.w = style[1];
    best.k = best.k === 1 ? 1 : 2;
  } else console.warn(`no building for landmark ${l.id}`);
}

const car = buildGraph(graphWays.car);
const ped = buildGraph(graphWays.ped);
const tram = buildGraph(graphWays.tram);
for (const e of car.edges) e.s ??= SPEED[e.c] ?? 8;

// the fallback river only matters if no water polygon covers it
const map = {
  bounds: [r1(minX), r1(minY), r1(maxX), r1(maxY)],
  origin: [LAT0, LON0],
  names,
  roads: roads.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.b ?? 0) - (b.b ?? 0) || b.c - a.c),
  trams,
  buildings,
  areas,
  rivers,
  pois,
  landmarks,
  graph: { car, ped, tram },
  tunnels,
  passages,
  barriers,
  trees,
  lamps,
  crossings,
  signals,
  tramStops,
  rails,
  flagsUntagged: 1,
};
await mkdir(new URL('.', OUT), { recursive: true });
const json = JSON.stringify(map);
await writeFile(OUT, json);
console.log(
  `wrote ${(json.length / 1e6).toFixed(2)} MB: ${roads.length} roads, ${buildings.length} buildings ` +
    `(${buildings.filter((b) => b.m).length} raised, ${buildings.filter((b) => b.u).length} without height), ` +
    Object.entries(areas).map(([k, v]) => `${v.length} ${k}`).join(', ') +
    `, ${trams.length} tram ways, ${pois.length} pois, ${landmarks.length} landmarks, ` +
    `car graph ${car.nodes.length / 2}n/${car.edges.length}e, ped ${ped.edges.length}e, tram ${tram.edges.length}e`,
);
