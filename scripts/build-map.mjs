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
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BBOX, ORIGIN, tiles } from './bbox.mjs';

const SRC = new URL('../.cache/osm/', import.meta.url);
const OUT = process.env.MAP_OUT ? pathToFileURL(resolve(process.env.MAP_OUT)) : new URL('../public/data/bratislava.json', import.meta.url);

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

// only this area's tiles (the cache may hold tiles of an older, smaller area)
const cached = new Set((await readdir(SRC)).filter((f) => f.endsWith('.osm')));
const files = tiles().map((t) => t.file);
const missing = files.filter((f) => !cached.has(f));
if (missing.length) throw new Error(`${missing.length} OSM tiles missing from .cache/osm (npm run fetch:osm)`);
for (const f of files) parse(await readFile(new URL(f, SRC), 'utf8'));
console.log(`parsed ${files.length} tiles: ${nodes.size} nodes, ${ways.size} ways, ${rels.size} relations`);

// ------------------------------------------------------------- projection
const LAT0 = ORIGIN.lat;
const LON0 = ORIGIN.lon;
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

/** Marked lanes of a car road: [total, forward, backward] (forward/backward 0 when not tagged),
 *  or null when the map doesn't say. */
function roadLanes(t) {
  const n = parseInt(t.lanes);
  if (!(n > 0 && n <= 8)) return null;
  const f = parseInt(t['lanes:forward']), b = parseInt(t['lanes:backward']);
  return [n, f > 0 && f <= n ? f : 0, b > 0 && b <= n ? b : 0];
}

/** How a car road is paved: 1 setts / cobblestones (the Old Town, bumpy, less grip), 2 paving
 *  stones (smooth pavers), 0 asphalt and the rest. */
function roadPaving(t) {
  const s = t.surface;
  if (s === 'sett' || s === 'cobblestone' || s === 'unhewn_cobblestone' || s === 'cobblestone:flattened') return 1;
  if (s === 'paving_stones' || s === 'paving_stones:30' || s === 'grass_paver') return 2;
  return 0;
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

/** CSS colour names OSM uses for building:colour / roof:colour, as hex */
const CSS_COLORS = {
  white: '#ffffff', snow: '#fffafa', ivory: '#fffff0', whitesmoke: '#f5f5f5', mintcream: '#f5fffa', aliceblue: '#f0f8ff', ghostwhite: '#f8f8ff',
  linen: '#faf0e6', beige: '#f5f5dc', oldlace: '#fdf5e6', cornsilk: '#fff8dc', lightyellow: '#ffffe0', lemonchiffon: '#fffacd', wheat: '#f5deb3',
  cream: '#f3ead3', gainsboro: '#dcdcdc', lightgrey: '#d3d3d3', lightgray: '#d3d3d3', silver: '#c0c0c0', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  gray: '#808080', grey: '#808080', dimgray: '#696969', dimgrey: '#696969', slategray: '#708090', slategrey: '#708090', lightslategray: '#778899',
  darkslategray: '#2f4f4f', black: '#262626', red: '#c0392b', darkred: '#8b0000', maroon: '#800000', brown: '#8b4a2b', firebrick: '#b22222',
  indianred: '#cd5c5c', crimson: '#c0203c', salmon: '#fa8072', lightsalmon: '#ffa07a', coral: '#ff7f50', tomato: '#ff6347', orangered: '#ff4500',
  orange: '#f39c12', darkorange: '#ff8c00', gold: '#e8c33a', yellow: '#f1d93b', khaki: '#f0e68c', darkkhaki: '#bdb76b', tan: '#d2b48c',
  burlywood: '#deb887', sandybrown: '#f4a460', peru: '#cd853f', chocolate: '#d2691e', sienna: '#a0522d', saddlebrown: '#8b4513', rosybrown: '#bc8f8f',
  pink: '#ffc0cb', lightpink: '#ffb6c1', hotpink: '#ff69b4', mistyrose: '#ffe4e1', lavender: '#e6e6fa', thistle: '#d8bfd8', plum: '#dda0dd',
  violet: '#ee82ee', purple: '#800080', indigo: '#4b0082', navy: '#1f2a5c', darkblue: '#1d2b7a', mediumblue: '#2a3fcd', blue: '#2e5fbf',
  royalblue: '#4169e1', steelblue: '#4682b4', cornflowerblue: '#6495ed', dodgerblue: '#1e90ff', deepskyblue: '#00bfff', skyblue: '#87ceeb',
  lightskyblue: '#87cefa', lightblue: '#add8e6', powderblue: '#b0e0e6', lightsteelblue: '#b0c4de', cadetblue: '#5f9ea0', teal: '#008080',
  darkcyan: '#008b8b', cyan: '#00ffff', lightcyan: '#e0ffff', turquoise: '#40e0d0', aquamarine: '#7fffd4', green: '#3f7d3a', darkgreen: '#1f5a1f',
  forestgreen: '#228b22', seagreen: '#2e8b57', olive: '#808000', olivedrab: '#6b8e23', darkolivegreen: '#556b2f', yellowgreen: '#9acd32',
  lightgreen: '#90ee90', palegreen: '#98fb98', darkseagreen: '#8fbc8f', mediumseagreen: '#3cb371', lime: '#32cd32', limegreen: '#32cd32',
};
/** a building:colour / roof:colour tag as '#rrggbb', or null */
function cssColor(v) {
  if (!v) return null;
  v = v.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  return CSS_COLORS[v] ?? null;
}
/** roof colour for a roof:material when no roof:colour is mapped (null: the game's own palette) */
const ROOF_MATERIAL = { copper: '#5f9a82', metal: '#8d949a', metal_sheet: '#8d949a', tin: '#8d949a', zinc: '#9aa3a8', slate: '#4f555c', glass: '#9fc3d6', concrete: '#a7a7a1', tar_paper: '#5a5a5c', gravel: '#9e9a92', grass: '#6f9a4e', plants: '#6f9a4e', eternit: '#7d7f80', asbestos: '#7d7f80', gold: '#d9b44a' };
/** wall colour for a building:material when no building:colour is mapped */
const WALL_MATERIAL = { brick: '#a4533f', glass: '#7fa4b8', concrete: '#a8a8a0', stone: '#cbbd9c', marble: '#eeeae2', metal: '#9aa0a6', steel: '#9aa0a6', wood: '#8b6a47', sandstone: '#d8c39a' };

/** roof shape codes (see BuildingJSON.rs) */
const ROOF_SHAPE = {
  flat: 1, gabled: 2, side_hipped: 2, saltbox: 2, double_saltbox: 2, quadruple_saltbox: 2, crosspitched: 2, gambrel: 2, sawtooth: 2, apse_gabled: 2,
  hipped: 3, 'half-hipped': 3, half_hipped: 3, mansard: 3, many: 3, pyramidal: 4, dome: 5, onion: 6, round: 7, skillion: 8, lean_to: 8, cone: 9, conical: 9,
};
/** shapes drawn as a raised roof of their own (roof:height up from the eaves) */
const RAISED_ROOF = new Set([4, 5, 6, 9]);

/** Height, kind, roof and colours of a building or building part from its tags. `levels` is the
 *  height of the walls in storeys (a raised roof - spire, dome, pyramid - sits on top of them,
 *  `roofH` metres tall); `minH` where it starts above the ground. */
function buildingInfo(t) {
  const lv = parseFloat(t['building:levels']);
  const h = parseFloat(t.height);
  const rl = parseFloat(t['roof:levels']);
  const small = ['garage', 'garages', 'shed', 'kiosk', 'roof', 'hut'].includes(t.building);
  // no height at all: default to 3 storeys and flag it, so the game can vary untagged heights
  const untagged = !(lv > 0) && !(h > 0) && !small;
  const shape = ROOF_SHAPE[t['roof:shape']] ?? 0;
  let roofH = parseFloat(t['roof:height']);
  if (!(roofH > 0)) roofH = rl > 0 && RAISED_ROOF.has(shape) ? rl * STOREY : 0;
  // the real height wins over a storey count; storeys alone leave out the roof, so an attic
  // (roof:levels) raises a pitched roof's ridge
  let levels = h > 0 ? h / STOREY : lv > 0 ? lv + (rl > 0 && !RAISED_ROOF.has(shape) ? Math.min(rl, 2) * 0.7 : 0) : small ? 1 : 3;
  if (RAISED_ROOF.has(shape) && roofH > 0) levels = h > 0 ? Math.max(1, (h - roofH) / STOREY) : levels;
  let kind = 0; // 0 normal, 1 church, 2 castle/landmark, 3 industrial, 4 roof/shelter, 5 tower structure drawn by the game
  if (['church', 'cathedral', 'chapel', 'synagogue', 'mosque', 'temple', 'shrine'].includes(t.building) || t.amenity === 'place_of_worship') kind = 1;
  if (t.historic === 'castle' || t.building === 'castle' || t.historic === 'city_gate') kind = 2;
  if (['industrial', 'warehouse', 'retail', 'commercial'].includes(t.building)) kind = 3;
  if (['roof', 'canopy', 'carport'].includes(t.building) || t['building:part'] === 'roof') kind = 4;
  // the Most SNP pylon legs and the UFO restaurant on top of them (building=bridge + man_made=tower)
  if (t.building === 'bridge' && t.man_made === 'tower') kind = 5;
  // a monument built as a building (Slavín): plain stone, no windows
  if (t.historic === 'monument' || t.building === 'monument' || (t.historic === 'memorial' && t.building && t.building !== 'yes')) kind = 6;
  levels = Math.min(60, Math.max(1, levels));
  // raised structures: the part of the building that starts above the ground (min_height,
  // building:min_level). Nothing stands under it at street level (the UFO, skywalks, arcades).
  let minH = parseFloat(t.min_height);
  if (!(minH > 0)) {
    const ml = parseFloat(t['building:min_level']);
    minH = ml > 0 ? ml * STOREY : 0;
  }
  if (minH >= levels * STOREY - 0.5) minH = 0;
  const roof = cssColor(t['roof:colour']) ?? ROOF_MATERIAL[t['roof:material']] ?? null;
  const wall = cssColor(t['building:colour']) ?? WALL_MATERIAL[t['building:material']] ?? null;
  return { levels, kind, untagged, minH, shape, roofH, roof, wall };
}

/** the BuildingJSON of a building or part from its (simplified) rings and tag info */
function buildingRecord(rs, info, seed) {
  const b = { r: rs.map(flat), l: Math.round(info.levels * 10) / 10, k: info.kind, s: seed };
  if (info.minH >= 2) b.m = r1(info.minH);
  if (info.shape) b.rs = info.shape;
  if (info.roofH > 0 && RAISED_ROOF.has(info.shape)) b.rh = r1(Math.min(60, info.roofH));
  if (info.roof) b.c = info.roof;
  if (info.wall) b.w = info.wall;
  return b;
}

function addBuilding(rings, t, id) {
  if (t.building === 'no' || t['building:part'] || t.location === 'underground' || t.layer < 0) return;
  const rs = rings.map((r) => simplify(r, 0.25)).filter((r) => r.length >= 4);
  if (!rs.length || !inView(rs[0])) return;
  const info = buildingInfo(t);
  const b = buildingRecord(rs, info, id % 997);
  if (info.untagged) b.u = 1;
  if (t.name) b.n = nameId(t.name);
  buildings.push(b);
}

/** building:part outlines (ways and multipolygons): towers, spires, naves, wings, each with its
 *  own height and roof. Matched to their buildings after the heights are settled (see "parts"). */
const partList = [];
function addPart(rings, t) {
  if (t.location === 'underground' || t.layer < 0 || t['building:part'] === 'no') return;
  const rs = rings.map((r) => simplify(r, 0.2)).filter((r) => r.length >= 4);
  if (!rs.length || !inView(rs[0])) return;
  partList.push({ rs, t, hasHeight: parseFloat(t.height) > 0 || parseFloat(t['building:levels']) > 0 });
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
  else if (t['building:part']) addPart([pts], t);
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
  if (!t.building && !t['building:part'] && !kind) continue;
  const outer = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref);
  const inner = r.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => m.ref);
  const outers = assembleRings(outer).filter((r) => r.length >= 4);
  if (!outers.length) continue;
  const inners = assembleRings(inner).filter((r) => r.length >= 4);
  const rings = [...outers, ...inners];
  if (t.building) addBuilding(rings, t, +id);
  else if (t['building:part']) addPart(rings, t);
  if (kind) addArea(kind, rings);
}

// Buildings OSM has no height for often have 3D building:parts that do (towers, wings,
// the cathedral...): use their area-weighted height instead of a guess.
for (const p of partList) {
  const ring = p.rs[0];
  p.cx = centroid(ring.slice(0, -1))[0];
  p.cy = centroid(ring.slice(0, -1))[1];
  p.area = polyArea(ring);
  p.info = buildingInfo(p.t);
  p.top = p.info.levels * STOREY + (p.info.roofH > 0 && RAISED_ROOF.has(p.info.shape) ? p.info.roofH : 0);
}
{
  const grid = new Grid(64);
  for (const p of partList) if (p.hasHeight) grid.add(p, p.cx, p.cy, p.cx, p.cy);
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
      b.l = Math.round(Math.min(60, Math.max(1, hsum / wsum / STOREY)) * 10) / 10;
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

// ---------------------------------------------------------------- building parts
// A building mapped in 3D (the cathedral: nave, chapels and its 85 m tower with a copper spire;
// the castle's wings and corner towers; the Blue Church's dome) is drawn as its parts, each at its
// own height with its own roof, instead of one block. The outline stays the solid footprint. When
// the parts cover most of it, only they are drawn; otherwise the outline is drawn as before and
// only the parts rising above it (towers, spires) are added on top.
{
  const outlineGrid = new Grid(48);
  buildings.forEach((b, i) => {
    if (b.k === 5) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of b.r) for (let k = 0; k < r.length; k += 2) (x0 = Math.min(x0, r[k])), (x1 = Math.max(x1, r[k])), (y0 = Math.min(y0, r[k + 1])), (y1 = Math.max(y1, r[k + 1]));
    outlineGrid.add({ i, b, x0, y0, x1, y1 }, x0, y0, x1, y1);
  });
  /** the smallest building outline the point lies in */
  const outlineAt = (x, y) => {
    let best = null;
    outlineGrid.query(x, y, x, y, (o) => {
      if (x < o.x0 || x > o.x1 || y < o.y0 || y > o.y1 || !pointInRings(x, y, o.b.r)) return;
      if (!best || flatArea(o.b.r[0]) < flatArea(best.b.r[0])) best = o;
    });
    return best;
  };
  const byParent = new Map();
  for (const p of partList) {
    const o = outlineAt(p.cx, p.cy);
    if (!o) continue;
    let l = byParent.get(o.i);
    if (!l) byParent.set(o.i, (l = []));
    l.push(p);
  }
  let hidden = 0, drawn = 0;
  const out = [];
  for (const [i, list] of byParent) {
    const parent = buildings[i];
    const area = flatArea(parent.r[0]);
    const top = parent.l * STOREY;
    let ground = 0;
    for (const p of list) if (p.info.minH < 1 && p.info.kind !== 4) ground += p.area;
    const hide = ground >= area * 0.75;
    for (const p of list) {
      const info = { ...p.info };
      // parts without a height of their own are as tall as their building
      if (!p.hasHeight) info.levels = parent.l;
      const partTop = info.levels * STOREY + (RAISED_ROOF.has(info.shape) ? info.roofH : 0);
      // over a drawn outline, only what rises above it (towers, spires, a dome)
      if (!hide && partTop < top + 1.5 && !(info.minH > 0 && info.minH >= top - 0.5)) continue;
      // the building's own character, where the part doesn't say otherwise
      if (!info.kind) info.kind = parent.k === 4 || parent.k === 5 ? 0 : parent.k;
      if (!info.roof && parent.c) info.roof = parent.c;
      if (!info.wall && parent.w) info.wall = parent.w;
      const b = buildingRecord(p.rs, info, parent.s);
      b.p = 1;
      // (for the landmark colours below; not written out)
      Object.defineProperty(b, 'parent', { value: parent, enumerable: false });
      Object.defineProperty(b, 'ownRoof', { value: !!p.info.roof, enumerable: false });
      Object.defineProperty(b, 'ownWall', { value: !!p.info.wall, enumerable: false });
      out.push(b);
      drawn++;
    }
    if (hide) {
      parent.x = 1;
      hidden++;
    }
  }
  buildings.push(...out);
  console.log(`building parts: ${drawn} drawn, ${hidden} outlines replaced by their parts (${partList.length} parts mapped)`);
}

// Spatial index of the footprints the game treats as solid (see World: not a canopy, not a
// sliver, not raised off the ground).
const solidGrid = new Grid(32);
for (const b of buildings) {
  if (b.k === 4 || b.m || b.p || flatArea(b.r[0]) <= 6) continue;
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
/** tram way id -> bit mask of the line numbers (route=tram relations) running along it */
const tramLines = new Map();
for (const r of rels.values()) {
  if (r.tags.route !== 'tram') continue;
  const ref = parseInt(r.tags.ref);
  if (!(ref > 0 && ref < 31)) continue;
  for (const m of r.members) if (m.type === 'way') tramLines.set(m.ref, (tramLines.get(m.ref) ?? 0) | (1 << ref));
}
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
      const lanes = c <= 7 ? roadLanes(t) : null;
      if (lanes) {
        road.l = lanes[0];
        if (lanes[1] || lanes[2]) road.lf = [lanes[1], lanes[2]];
      }
      const paving = c <= 7 ? roadPaving(t) : 0;
      if (paving) road.s = paving;
      roads.push(road);
      kept.push({ w, pts, c, width, bridge: !!bridge });
      for (const n of w.nds) surfaceRoadNodes.add(n);
      if (drivable) {
        graphWays.car.push({ w, c, oneway: road.o ?? 0, width: road.w, name: road.n ?? -1, speed: maxspeed(t), lanes });
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
      graphWays.tram.push({ w, c: 0, oneway: 0, width: 3, name: -1, tram: tramLines.get(id) });
    } else if (vert !== 'indoor' && vert !== 'underground') {
      trams.push(flat(simplify(pts, 0.3)));
      graphWays.tram.push({ w, c: 0, oneway: 0, width: 3, name: -1, tram: tramLines.get(id) });
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

// ---------------------------------------------------------------- fountains
// Fountains are water inside a stone basin: the rim stops people and cars. OSM maps most of the
// big ones (the Roland fountain on Hlavné námestie, Ganymede's in front of the theatre) as
// amenity=fountain outlines without natural=water, so they become water areas here; smaller
// fountains mapped as a point get a basin a few metres across. Every small water area (the
// fountains, ornamental pools) gets a rim, opened like a wall where a path crosses it.
/** water smaller than this is ornamental (must match the World's drowning cut-off) */
const POOL_MAX = 4000;
/** outlines of the basins, for the barrier pass below */
const fountainRims = [];
{
  const isWater = (t) => t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'basin' || t.landuse === 'reservoir';
  let added = 0;
  for (const w of ways.values()) {
    const t = w.tags;
    if (t.amenity !== 'fountain' || isWater(t) || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
    const pts = wayPts(w);
    if (pts.length < 4 || !inView(pts)) continue;
    areas.water.push([flat(simplify(pts, 0.15))]);
    added++;
  }
  const circle = (x, y, r) => {
    const out = [];
    for (let i = 0; i <= 12; i++) out.push([x + Math.cos((i / 12) * Math.PI * 2) * r, y + Math.sin((i / 12) * Math.PI * 2) * r]);
    return out;
  };
  const onWay = new Set();
  for (const w of ways.values()) for (const n of w.nds) onWay.add(n);
  for (const [id, n] of nodes) {
    const t = n.tags;
    if (t.amenity !== 'fountain' || onWay.has(id) || ['splash_pad', 'bubbler', 'drinking', 'toilets', 'nozzle'].includes(t.fountain)) continue;
    const [x, y] = project(n.lat, n.lon);
    if (!inBounds(x, y) || insideOf(solidGrid, x, y)) continue;
    // already inside a mapped basin
    if (areas.water.some((rings) => pointInRings(x, y, rings))) continue;
    // a basin can't stand on a street or a path (the point is a spout on it, or a drinking fountain)
    let onPath = false;
    for (const k of kept)
      for (let i = 1; i < k.pts.length && !onPath; i++)
        if (Math.abs(k.pts[i][0] - x) < 40 && segDist(x, y, k.pts[i - 1][0], k.pts[i - 1][1], k.pts[i][0], k.pts[i][1]) < k.width / 2 + 1.8) onPath = true;
    if (onPath) continue;
    areas.water.push([flat(circle(x, y, 1.6))]);
    added++;
  }
  for (const rings of areas.water) if (flatArea(rings[0]) < POOL_MAX) for (const r of rings) fountainRims.push(r);
  console.log(`fountains: ${added} basins added, ${fountainRims.length} rims`);
}

// ---------------------------------------------------------------- barriers
// Walls, fortifications, fences and hedges, cut open wherever a street or path goes through
// them (gates and entrances included), and wherever the line conflicts with a street's roadway.
/** 0 wall, 1 fortification (city/castle walls), 2 retaining wall, 3 fence, 4 hedge, 5 concrete barrier, 6 noise barrier, 7 flood wall, 8 fountain rim */
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
const BARRIER_HT = [0.25, 0.9, 0.3, 0.06, 0.45, 0.3, 0.15, 0.25, 0.3];
const GATES = new Set(['gate', 'entrance', 'lift_gate', 'swing_gate', 'wicket_gate', 'kissing_gate', 'turnstile', 'sliding_gate', 'hampshire_gate', 'stile', 'cattle_grid', 'full-height_turnstile', 'bump_gate', 'chain', 'cycle_barrier', 'bollard']);
const barriers = [];
// surface street segments (bridges and tunnels don't cut ground-level walls), with their class
const segGrid = new Grid(16);
for (const k of kept) {
  if (k.bridge) continue;
  for (let i = 1; i < k.pts.length; i++) {
    const [ax, ay] = k.pts[i - 1], [bx, by] = k.pts[i];
    const s = { ax, ay, bx, by, hw: k.width / 2, c: k.c, w: k.w };
    segGrid.add(s, Math.min(ax, bx) - s.hw, Math.min(ay, by) - s.hw, Math.max(ax, bx) + s.hw, Math.max(ay, by) + s.hw);
  }
}
const keptNodes = new Set();
for (const k of kept) if (!k.bridge) for (const n of k.w.nds) keptNodes.add(n);
{
  let total = 0, removed = 0;
  const lines = [];
  for (const w of ways.values()) {
    const kind = w.tags.barrier ? barrierKind(w.tags) : -1;
    if (kind >= 0) lines.push({ pts: wayPts(w), nds: w.nds, kind });
  }
  for (const r of fountainRims) {
    const pts = [];
    for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
    lines.push({ pts, nds: null, kind: 8 });
  }
  for (const { pts, nds, kind } of lines) {
    if (pts.length < 2 || !inView(pts)) continue;
    const cum = cumLen(pts);
    const L = cum[cum.length - 1];
    if (L < 0.5) continue;
    total += L;
    if (kind === 8) {
      // a fountain's basin stays whole: paths run round it (a path mapped across one is a
      // mapping shortcut people walk round, see `crossesFountain`)
      barriers.push({ p: flat(simplify(pts, 0.1)), k: kind });
      continue;
    }
    const gaps = [];
    // shared nodes with streets and paths, and gate nodes on the barrier
    for (let i = 0; nds && i < nds.length; i++) {
      const nt = nodes.get(nds[i])?.tags ?? {};
      if (keptNodes.has(nds[i])) gaps.push([cum[i] - 1.7, cum[i] + 1.7]);
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

// ------------------------------------------------- street furniture and monuments
// Solid things OSM maps as points: bollards, concrete blocks and big planters that close a street
// or path to cars (a row across the way, with gaps people walk through), and free-standing
// statues, columns and memorials. Flat [x, y, radius, kind] with kinds indexing World.POSTS:
// 0 bollard, 1 block, 2 planter, 3 statue, 4 column, 5 memorial stone.
const posts = [];
/** node id of a bollard (block, planter) row -> the ways it closes to cars, and where the row is */
const closes = new Map();
const closesWay = (n, w) => closes.get(n)?.ways.has(w) ?? false;
{
  const onWay = new Set();
  for (const w of ways.values()) for (const n of w.nds) onWay.add(n);
  const waysAt = new Map();
  for (const k of kept) if (!k.bridge) k.w.nds.forEach((n, i) => (waysAt.get(n) ?? waysAt.set(n, []).get(n)).push({ k, i }));
  const bigWater = areas.water.filter((rings) => flatArea(rings[0]) >= POOL_MAX);
  const clear = (x, y) => inBounds(x, y) && !insideOf(solidGrid, x, y) && !bigWater.some((rings) => pointInRings(x, y, rings));
  /** [kind, radius, centre spacing] of a row across a way */
  const ROW = { bollard: [0, 0.12, 1.5], block: [1, 0.45, 1.9], jersey_barrier: [1, 0.45, 1.9], planter: [2, 0.55, 2.2] };
  let rows = 0, free = 0, monuments = 0;
  for (const [id, n] of nodes) {
    const spec = ROW[n.tags.barrier];
    if (!spec) continue;
    const [kind, r, spacing0] = spec;
    const [x, y] = project(n.lat, n.lon);
    const at = waysAt.get(id);
    if (!at) {
      // a free-standing post (they line the edges of squares): never in a carriageway
      let inRoad = false;
      segGrid.query(x - 10, y - 10, x + 10, y + 10, (s) => {
        if (!inRoad && s.c <= 7 && segDist(x, y, s.ax, s.ay, s.bx, s.by) < s.hw - 0.2) inRoad = true;
      });
      if (!inRoad && clear(x, y)) posts.push(r1(x), r1(y), r2(r), kind), free++;
      continue;
    }
    // the way the row closes: a path or pedestrian street it stands at the end of (the street it
    // meets stays open), else the smallest way through it
    const ends = at.filter((a) => a.i === 0 || a.i === a.k.w.nds.length - 1);
    const { k, i } = (ends.length && ends.length < at.length ? ends : at).reduce((a, b) => (b.k.c > a.k.c ? b : a));
    const pts = k.pts, m = pts.length;
    if (m < 2 || i >= m) continue;
    const [ax, ay] = pts[Math.max(0, i - 1)], [bx, by] = pts[Math.min(m - 1, i + 1)];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    // at a junction, set the row a little way into the way it closes
    const into = at.length > 1 ? (i === 0 ? 0.9 : i === m - 1 ? -0.9 : 0) : 0;
    const cx = x + ux * into, cy = y + uy * into;
    const gap = parseFloat(n.tags['maxwidth:physical']);
    const spacing = gap > 0.4 && gap < 3 ? gap + 2 * r : spacing0;
    const hw = k.width / 2;
    // it closes the way it stands across, and any other way that ends at it (two streets meeting
    // end to end at a row of bollards are no longer one street for cars)
    const cut = new Set([k.w]);
    for (const a of ends) cut.add(a.k.w);
    // ...but never stands in a street that stays open beside it
    const inOpenRoad = (px, py) => {
      let hit = false;
      segGrid.query(px - 10, py - 10, px + 10, py + 10, (sg) => {
        if (!hit && sg.c <= 7 && !cut.has(sg.w) && segDist(px, py, sg.ax, sg.ay, sg.bx, sg.by) < sg.hw + r) hit = true;
      });
      return hit;
    };
    for (let j = -Math.floor((hw - 0.15) / spacing); j * spacing <= hw - 0.15; j++) {
      const px = cx - uy * j * spacing, py = cy + ux * j * spacing;
      if (clear(px, py) && !inOpenRoad(px, py)) posts.push(r1(px), r1(py), r2(r), kind);
    }
    closes.set(id, { ways: cut, x: cx, y: cy });
    rows++;
  }
  // statues, columns and memorials standing free (a point on a way is a plaque or a relief in a
  // wall), and not in a street or on a path
  const monument = (t) => {
    const m = t.memorial ?? t.artwork_type ?? '';
    if (t.man_made === 'column' || t.man_made === 'obelisk' || m === 'column' || m === 'obelisk') return [4, 1.8];
    if (t.historic === 'memorial' || t.tourism === 'artwork') {
      if (m === 'statue' || m === 'sculpture') return [3, 0.8];
      if (m === 'bust') return [3, 0.45];
      if (m === 'war_memorial') return [5, 1.2];
      if (m === 'stele' || m === 'stone' || m === 'cross') return [5, 0.5];
    }
    if (t.historic === 'wayside_cross' || t.historic === 'wayside_shrine') return [5, 0.5];
    return null;
  };
  for (const [id, n] of nodes) {
    const m = monument(n.tags);
    if (!m || onWay.has(id)) continue;
    const [kind, r] = m;
    const [x, y] = project(n.lat, n.lon);
    if (!clear(x, y)) continue;
    let inWay = false;
    segGrid.query(x - 12, y - 12, x + 12, y + 12, (s) => {
      const d = segDist(x, y, s.ax, s.ay, s.bx, s.by);
      if (s.c <= 7 ? d < s.hw + r - 0.2 : d < r + 0.8) inWay = true;
    });
    if (inWay) continue;
    posts.push(r1(x), r1(y), r2(r), kind);
    monuments++;
  }
  console.log(`posts: ${rows} bollard/block rows closing ways to cars, ${free} free-standing posts, ${monuments} statues/columns/memorials`);
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

// ------------------------------------------------ the street in detail: kerbs, gates, signs, furniture
/** kept surface ways through each node (not bridges) */
const keptAt = new Map();
for (const k of kept) if (!k.bridge) k.w.nds.forEach((n, i) => (keptAt.get(n) ?? keptAt.set(n, []).get(n)).push({ k, i }));
/** the nearest surface street or path segment to (x, y) within `r` m (optionally only car roads):
 *  its direction, how far off it the point is and which side */
function nearestSeg(x, y, r, cars = false) {
  let best = null, bd = r;
  segGrid.query(x - r, y - r, x + r, y + r, (s) => {
    if (cars && s.c > 7) return;
    const d = segDist(x, y, s.ax, s.ay, s.bx, s.by) - (cars ? s.hw : 0);
    if (d < bd) (bd = d), (best = s);
  });
  if (!best) return null;
  const a = Math.atan2(best.by - best.ay, best.bx - best.ax);
  // which side of the segment's direction the point is on (+1: right of it, y down)
  const side = (best.bx - best.ax) * (y - best.ay) - (best.by - best.ay) * (x - best.ax) >= 0 ? 1 : -1;
  return { s: best, a, d: bd, side };
}
/** a compass `direction` tag (degrees from north, or N/NE/...) as a game angle (0 = east, y down) */
function tagAngle(v) {
  if (!v) return null;
  const card = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 }[v.toUpperCase()];
  const deg = card ?? parseFloat(v);
  return Number.isFinite(deg) ? ((deg - 90) * Math.PI) / 180 : null;
}
const bigWaterRings = areas.water.filter((rings) => flatArea(rings[0]) >= POOL_MAX);
const dryAt = (x, y) => inBounds(x, y) && !insideOf(solidGrid, x, y) && !bigWaterRings.some((rings) => pointInRings(x, y, rings));

// Raised traffic islands in the carriageway (area:highway=traffic_island): kerbed, grassed or
// paved. Cars jolt up onto them and drag over them (World.onIsland), traffic's lanes keep off them.
const islands = [];
{
  const greenAt = (x, y) => areas.green.some((rings) => pointInRings(x, y, rings));
  for (const w of ways.values()) {
    const t = w.tags;
    if (t['area:highway'] !== 'traffic_island' || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
    const pts = wayPts(w);
    if (pts.length < 4 || !inView(pts)) continue;
    const area = polyArea(pts);
    if (area < 1.5 || area > 4000) continue;
    const [cx, cy] = centroid(pts.slice(0, -1));
    // an island up on a bridge deck isn't in the street under it
    let onDeck = false;
    for (const k of kept) if (k.bridge) for (let i = 1; i < k.pts.length && !onDeck; i++) if (segDist(cx, cy, k.pts[i - 1][0], k.pts[i - 1][1], k.pts[i][0], k.pts[i][1]) < k.width / 2) onDeck = true;
    if (onDeck) continue;
    const isl = { p: flat(simplify(pts, 0.15)) };
    if (t.surface === 'grass' || t.landuse === 'grass' || (!t.surface && greenAt(cx, cy))) isl.g = 1;
    islands.push(isl);
  }
}

// Lift gates (boom barriers) at car park and service entrances: [x, y, direction of the way, boom
// length]. Traffic doesn't route through them (the car graph is cut there, see cutAtClosures);
// a car that rams one snaps the boom (World.gates).
const gates = [];
/** node id of a lift gate -> the drivable way it closes */
const gatesAt = new Map();
for (const [id, n] of nodes) {
  if (n.tags.barrier !== 'lift_gate') continue;
  const [x, y] = project(n.lat, n.lon);
  if (!inBounds(x, y)) continue;
  const at = keptAt.get(id);
  if (!at) continue;
  const { k, i } = at.reduce((a, b) => (b.k.c < a.k.c ? b : a));
  gates.push(r1(x), r1(y), r2(wayAngle(k.w, i)), r1(Math.min(8, Math.max(3, k.width))));
  if (DRIVABLE.has(k.c)) gatesAt.set(id, { ways: new Set(at.map((a) => a.k.w)), x, y });
}

// Bridge piers standing in the river and on its banks: solid at street level, under the decks.
const supports = [];
for (const w of ways.values()) {
  if (!w.tags['bridge:support'] || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
  const pts = wayPts(w);
  if (pts.length >= 4 && inView(pts)) supports.push(flat(simplify(pts, 0.2)));
}
for (const n of nodes.values()) {
  if (!n.tags['bridge:support']) continue;
  const [x, y] = project(n.lat, n.lon);
  if (!inBounds(x, y)) continue;
  const ring = [];
  for (let i = 0; i <= 8; i++) ring.push([x + Math.cos((i / 8) * Math.PI * 2) * 1.3, y + Math.sin((i / 8) * Math.PI * 2) * 1.3]);
  supports.push(flat(ring));
}

// Speed bumps and raised tables: [x, y, street direction, street half-width, kind] (kind 0 bump,
// 1 raised table, 2 speed cushions, 3 rumble strip). Traffic slows for them; a car that doesn't
// takes off.
const calming = [];
{
  const KIND = { bump: 0, hump: 0, yes: 0, table: 1, cushion: 2, rumble_strip: 3, mini_bumps: 3, dip: 3 };
  for (const [id, n] of nodes) {
    const kind = KIND[n.tags.traffic_calming];
    if (kind === undefined) continue;
    const at = carWaysAt.get(id);
    if (!at) continue;
    const [x, y] = project(n.lat, n.lon);
    if (!inBounds(x, y)) continue;
    const main = at.reduce((a, b) => (b.c < a.c ? b : a));
    calming.push(r1(x), r1(y), r2(wayAngle(main.w, main.i)), r1(main.width / 2), kind);
  }
}

// Stop and give-way signs: [x, y, direction of the traffic they stop, street half-width, kind] (kind
// 0 stop, 1 give way). A sign without a direction faces the traffic heading into the junction it
// stands nearest.
const yields = [];
{
  const junction = (n) => (carWaysAt.get(n)?.length ?? 0) > 1 || (surfaceRoadNodes.has(n) && (keptAt.get(n)?.filter((a) => DRIVABLE.has(a.k.c)).length ?? 0) > 1);
  for (const [id, n] of nodes) {
    const hw = n.tags.highway;
    if (hw !== 'stop' && hw !== 'give_way') continue;
    const at = carWaysAt.get(id);
    if (!at) continue;
    const [x, y] = project(n.lat, n.lon);
    if (!inBounds(x, y)) continue;
    const kind = hw === 'stop' ? 0 : 1;
    const dir = n.tags.direction ?? n.tags['traffic_sign:direction'];
    // on a junction node itself: it stops the minor roads coming in
    if (at.length > 1 && !dir) {
      const major = Math.min(...at.map((a) => a.c));
      for (const a of at) {
        if (a.c === major) continue;
        const ang = wayAngle(a.w, a.i);
        // toward the node: along the way if the node is at its end, against it at its start
        if (a.i > 0) yields.push(r1(x), r1(y), r2(ang), r1(a.width / 2), kind);
        if (a.i < a.w.nds.length - 1) yields.push(r1(x), r1(y), r2(ang + Math.PI), r1(a.width / 2), kind);
      }
      continue;
    }
    const { w, i, width } = at[0];
    const ang = wayAngle(w, i);
    let travel = null;
    if (dir === 'forward') travel = ang;
    else if (dir === 'backward') travel = ang + Math.PI;
    else {
      // the nearer junction along the way decides
      let fwdD = Infinity, backD = Infinity;
      for (let j = i + 1, d = 0; j < w.nds.length; j++) {
        const a = xy(w.nds[j - 1]), b = xy(w.nds[j]);
        if (!a || !b) break;
        d += Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (junction(w.nds[j])) {
          fwdD = d;
          break;
        }
      }
      for (let j = i - 1, d = 0; j >= 0; j--) {
        const a = xy(w.nds[j + 1]), b = xy(w.nds[j]);
        if (!a || !b) break;
        d += Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (junction(w.nds[j])) {
          backD = d;
          break;
        }
      }
      if (fwdD === Infinity && backD === Infinity) continue;
      travel = fwdD <= backD ? ang : ang + Math.PI;
    }
    yields.push(r1(x), r1(y), r2(Math.atan2(Math.sin(travel), Math.cos(travel))), r1(width / 2), kind);
  }
}

// Street furniture: [x, y, angle, kind] (see World.FURNITURE: 0 bench, 1 litter bin, 2 fire hydrant,
// 3 bus stop, 4 bus shelter, 5 billboard, 6 advertising column, 7 bicycle stand, 8 post box, 9 café
// table, 10 drinking fountain, 11 recycling containers, 12 flagpole, 13 bike-share dock, 14 picnic
// table, 15 charging station). Cars knock the small things flying; people sit on the benches.
const furniture = [];
{
  const add = (x, y, a, kind) => furniture.push(r1(x), r1(y), r2(Math.atan2(Math.sin(a), Math.cos(a))), kind);
  const kindOf = (t) =>
    t.amenity === 'bench' ? 0 :
    t.amenity === 'waste_basket' ? 1 :
    t.emergency === 'fire_hydrant' && t['fire_hydrant:type'] !== 'underground' ? 2 :
    t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes') ? (t.shelter === 'yes' ? 4 : 3) :
    t.advertising === 'billboard' ? 5 :
    t.advertising === 'column' ? 6 :
    t.amenity === 'bicycle_parking' && (t.bicycle_parking === 'stands' || t.bicycle_parking === 'rack' || !t.bicycle_parking) ? 7 :
    t.amenity === 'post_box' ? 8 :
    t.amenity === 'drinking_water' ? 10 :
    t.amenity === 'recycling' && t.recycling_type !== 'centre' ? 11 :
    t.man_made === 'flagpole' ? 12 :
    t.amenity === 'bicycle_rental' ? 13 :
    t.leisure === 'picnic_table' ? 14 :
    t.amenity === 'charging_station' ? 15 : -1;
  const seen = new Set();
  const place = (x, y, t, kind, wayDir) => {
    if (!dryAt(x, y)) return;
    // one of a kind per spot (a stop mapped as a platform and a stop point)
    const key = `${kind}:${Math.round(x / 2)}:${Math.round(y / 2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    let a = tagAngle(t.direction);
    // benches, billboards and stops line up with the nearest street or path and face it
    const near = nearestSeg(x, y, kind === 3 || kind === 4 ? 14 : 8, kind === 3 || kind === 4);
    if (a === null && wayDir !== undefined) a = wayDir;
    if (a === null && near) a = near.a + (near.side > 0 ? -Math.PI / 2 : Math.PI / 2);
    // a stop's sign or shelter stands in the carriageway in the data now and then: onto the kerb
    if ((kind === 3 || kind === 4) && near && near.d < 0.6) {
      const push = 0.6 - near.d, nx = -Math.sin(near.a) * near.side, ny = Math.cos(near.a) * near.side;
      (x += nx * push), (y += ny * push);
    }
    add(x, y, a ?? 0, kind);
  };
  for (const n of nodes.values()) {
    const kind = kindOf(n.tags);
    if (kind < 0) continue;
    const [x, y] = project(n.lat, n.lon);
    place(x, y, n.tags, kind);
  }
  for (const w of ways.values()) {
    const kind = kindOf(w.tags);
    if (kind !== 0 && kind !== 4) continue; // benches and shelters mapped as outlines
    const pts = wayPts(w);
    if (pts.length < 2 || !inView(pts)) continue;
    const [x, y] = centroid(w.nds[0] === w.nds[w.nds.length - 1] ? pts.slice(0, -1) : pts);
    // the long side's direction
    let best = 0, dir = 0;
    for (let i = 1; i < pts.length; i++) {
      const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (L > best) (best = L), (dir = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]));
    }
    place(x, y, w.tags, kind, dir + Math.PI / 2);
  }
  // café terraces: tables in rows over the mapped seating area
  let tables = 0;
  for (const w of ways.values()) {
    if (w.tags.leisure !== 'outdoor_seating' || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
    const pts = wayPts(w);
    if (pts.length < 4 || !inView(pts)) continue;
    const ring = flat(pts);
    let best = 0, dir = 0;
    for (let i = 1; i < pts.length; i++) {
      const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (L > best) (best = L), (dir = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]));
    }
    const ux = Math.cos(dir), uy = Math.sin(dir);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [px, py] of pts) {
      const u = px * ux + py * uy, v = -px * uy + py * ux;
      (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
    }
    let n = 0;
    for (let u = u0 + 1.3; u <= u1 - 1.1 && n < 24; u += 2.6)
      for (let v = v0 + 1.2; v <= v1 - 1.0 && n < 24; v += 2.4) {
        const x = u * ux - v * uy, y = u * uy + v * ux;
        if (!pointInRings(x, y, [ring]) || !dryAt(x, y)) continue;
        add(x, y, dir, 9);
        n++;
      }
    tables += n;
  }
  const counts = {};
  for (let i = 3; i < furniture.length; i += 4) counts[furniture[i]] = (counts[furniture[i]] ?? 0) + 1;
  console.log(`street: ${islands.length} traffic islands, ${gates.length / 4} lift gates, ${supports.length} bridge piers, ${calming.length / 5} speed bumps/tables, ${yields.length / 5} stop/give-way signs, ${furniture.length / 4} pieces of street furniture (${tables} café tables) ${JSON.stringify(counts)}`);
}

// Places people go, by kind: [{k, x, y, n?}] (the name only for museums, galleries, theatres,
// churches and libraries; cafés, bars and restaurants stay anonymous)
const places = [];
{
  const kindOf = (t) =>
    ['restaurant', 'fast_food', 'food_court'].includes(t.amenity) ? 'food' :
    t.amenity === 'cafe' || t.amenity === 'ice_cream' ? 'cafe' :
    ['bar', 'pub', 'biergarten', 'nightclub'].includes(t.amenity) ? 'bar' :
    t.amenity === 'pharmacy' || t.healthcare === 'pharmacy' ? 'pharmacy' :
    t.tourism === 'museum' || t.tourism === 'gallery' ? 'museum' :
    ['theatre', 'cinema', 'concert_hall'].includes(t.amenity) ? 'theatre' :
    ['hotel', 'hostel', 'guest_house', 'motel'].includes(t.tourism) ? 'hotel' :
    ['supermarket', 'convenience', 'greengrocer'].includes(t.shop) ? 'grocery' :
    t.shop === 'bakery' || t.shop === 'pastry' ? 'bakery' :
    t.amenity === 'place_of_worship' ? 'church' :
    t.amenity === 'bank' ? 'bank' :
    t.amenity === 'post_office' ? 'post' :
    t.amenity === 'library' ? 'library' :
    t.tourism === 'viewpoint' ? 'view' :
    t.amenity === 'toilets' ? 'wc' :
    t.amenity === 'taxi' ? 'taxi' : null;
  const NAMED = new Set(['museum', 'theatre', 'church', 'library']);
  const grid = new Grid(24);
  const add = (k, x, y, name) => {
    let dup = false;
    grid.query(x - 15, y - 15, x + 15, y + 15, (p) => {
      if (p.k === k && Math.hypot(p.x - x, p.y - y) < 15 && (!NAMED.has(k) || p.name === name)) dup = true;
    });
    if (dup || !inBounds(x, y)) return;
    const pl = { k, x: r1(x), y: r1(y) };
    if (NAMED.has(k) && name) pl.n = nameId(name);
    grid.add({ k, x, y, name }, x, y, x, y);
    places.push(pl);
  };
  for (const [type, map] of [['way', ways], ['relation', rels], ['node', nodes]])
    for (const el of map.values()) {
      const t = el.tags;
      if (!t) continue;
      const k = kindOf(t);
      if (!k) continue;
      const p = elementAt(type, el);
      if (p) add(k, p[0], p[1], t.name);
    }
  const byKind = {};
  for (const p of places) byKind[p.k] = (byKind[p.k] ?? 0) + 1;
  console.log(`places: ${places.length} ${JSON.stringify(byKind)}`);
}

// Where you are: the city's boroughs (their real boundaries), the named quarters inside them, and
// the squares.
const districts = [];
const quarters = [];
const squares = [];
{
  for (const r of rels.values()) {
    const t = r.tags;
    if (t.boundary !== 'administrative' || t.admin_level !== '9' || !t.name) continue;
    const outer = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref);
    const rings = assembleRings(outer).filter((ring) => ring.length >= 4).map((ring) => flat(simplify(ring, 5)));
    if (!rings.length || !rings.some((ring) => inView(ring.reduce((a, v, i) => (i % 2 ? a : a.concat([[v, ring[i + 1]]])), [])))) continue;
    districts.push({ n: nameId(t.name.replace(/^Bratislava-/, '')), r: rings });
  }
  for (const n of nodes.values()) {
    const t = n.tags;
    if (!['neighbourhood', 'quarter', 'locality'].includes(t.place) || !t.name) continue;
    const [x, y] = project(n.lat, n.lon);
    if (inBounds(x, y, 400)) quarters.push({ n: nameId(t.name), x: r1(x), y: r1(y) });
  }
  const addSquare = (name, rings) => {
    const rs = rings.filter((ring) => ring.length >= 4 && inView(ring)).map((ring) => flat(simplify(ring, 0.8)));
    if (rs.length) squares.push({ n: nameId(name), r: rs });
  };
  for (const w of ways.values()) {
    const t = w.tags;
    if (t.place !== 'square' || !t.name || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
    addSquare(t.name, [wayPts(w)]);
  }
  for (const r of rels.values()) {
    const t = r.tags;
    if (t.place !== 'square' || !t.name) continue;
    const outer = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref);
    addSquare(t.name, assembleRings(outer));
  }
  console.log(`areas: ${districts.length} boroughs (${districts.map((d) => names[d.n]).join(', ')}), ${quarters.length} quarters, ${squares.length} squares`);
}

// tram stop names, in the order of `tramStops`
const tramStopNames = [];
for (let i = 0; i < tramStops.length; i += 2) {
  let best = -1, bd = 25;
  for (const n of nodes.values()) {
    const t = n.tags;
    if (!t.name || !(t.railway === 'tram_stop' || (t.public_transport === 'stop_position' && t.tram === 'yes') || (t.public_transport === 'platform' && t.tram === 'yes'))) continue;
    const [x, y] = project(n.lat, n.lon);
    const d = Math.hypot(x - tramStops[i], y - tramStops[i + 1]);
    if (d < bd) (bd = d), (best = nameId(t.name));
  }
  tramStopNames.push(best);
}

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
  for (const { w, c, oneway, width, name, speed, lanes, tram } of list) {
    const nds = w.nds.filter((n) => nodes.has(n));
    // marked lanes each way, when there's more than one to choose from (see EdgeJSON.ln)
    let ln = null;
    if (lanes) {
      const [n, lf, lb] = lanes;
      const fwd = oneway === 1 ? n : oneway === -1 ? 0 : lf || (lb ? Math.max(1, n - lb) : (n + 1) >> 1);
      const bwd = oneway === 1 ? 0 : oneway === -1 ? n : lb || Math.max(1, n - fwd);
      if (Math.max(fwd, bwd) >= 2) ln = [fwd, bwd];
    }
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
          if (ln) e.ln = ln;
          if (tram) e.r = tram;
          // a row of bollards across it (people get through, cars don't), or it's mapped across a
          // fountain: no way for a car
          if (seg.some((n) => closesWay(n, w)) || crossesFountain(pts)) e.x = 1;
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
/** Landmarks: [id, label, name patterns (first that matches wins), options]. `near` picks the
 *  match closest to a point (several things share a name: a tram stop and the tower it's named
 *  after), `ok` filters by tags, `style` gives [roof, walls] colours the map doesn't have. */
const isPlace = (t) => !t.highway && !t.railway && !t.public_transport && !t.route && !t.amenity?.startsWith('bicycle') && t.amenity !== 'parking';
const LANDMARKS = [
  ['castle', 'Bratislavský hrad', [/^Bratislavský hrad$/], { style: ['#b8553a', '#f3efe6'] }],
  ['michael', 'Michalská brána', [/^Michalská brána$/, /^Michalská veža$/], { style: ['#4f8a6e', '#f0ebe0'] }],
  ['snp', 'Most SNP (UFO)', [/^UFO$/, /^Most SNP$/]],
  ['cathedral', 'Dóm sv. Martina', [/Dóm svätého Martina/, /Katedrála svätého Martina/, /Dóm sv\. Martina/], { style: ['#59646c', '#d9d0bd'] }],
  ['primate', 'Primaciálny palác', [/^Primaciálny palác$/], { style: ['#a44a35', '#f2d4cf'] }],
  ['blue', 'Modrý kostolík', [/Kostol svätej Alžbety/, /Modrý kostol/], { style: ['#5f9fd6', '#a9cde8'] }],
  ['eurovea', 'Eurovea', [/^Eurovea$/], { style: ['#c9ced2', '#8fa4b3'] }],
  ['market', 'Stará tržnica', [/^Stará tržnica$/], { style: ['#9a4b3a', '#e6d6b8'] }],
  ['snd', 'Slovenské národné divadlo', [/Historická budova SND/, /^Slovenské národné divadlo$/], { near: [-176, -151], style: ['#6b7d8a', '#efe6cf'] }],
  ['cumil', 'Čumil', [/Čumil/]],
  ['main', 'Hlavné námestie', [/^Hlavné námestie$/]],
  ['president', 'Prezidentský palác', [/Grasalkovičov palác/, /Prezidentský palác/], { style: ['#7b8a92', '#f2ecdc'] }],
  ['apollo', 'Most Apollo', [/^Most Apollo$/]],
  ['sad', 'Sad Janka Kráľa', [/^Sad Janka Kráľa$/], { ok: (t) => t.leisure === 'park' }],
  ['oldbridge', 'Starý most', [/^Starý most$/]],
  ['hviezdoslav', 'Hviezdoslavovo námestie', [/^Hviezdoslavovo námestie$/]],
  ['reduta', 'Reduta', [/^Reduta$/], { style: ['#6f7d86', '#f0e1c0'] }],
  ['sng', 'Slovenská národná galéria', [/^Slovenská národná galéria$/], { style: ['#b0413e', '#e8e0d0'] }],
  ['kamenne', 'Kamenné námestie', [/^Kamenné námestie$/]],
  ['aupark', 'Aupark', [/^Aupark$/]],
  ['parliament', 'Národná rada SR', [/Národná rada Slovenskej republiky/], { style: ['#9aa3a8', '#e8e4da'] }],
  // the Old Town
  ['radnica', 'Stará radnica', [/^Stará radnica$/], { style: ['#8f5b34', '#ecd9b8'] }],
  ['jesuit', 'Jezuitský kostol', [/^Kostol Najsvätejšieho Spasiteľa$/], { style: ['#6d4c3d', '#f2ede2'] }],
  ['franciscan', 'Františkánsky kostol', [/^Kostol Zvestovania Pána$/], { style: ['#7a4a3a', '#e8e1d2'] }],
  ['klarisky', 'Klarisky', [/^Kláštor Klarisiek$/, /Povýšenia svätého Kríža/], { style: ['#6f5446', '#ece4d4'] }],
  ['mirbach', 'Mirbachov palác', [/^Mirbachov palác$/], { style: ['#8a5a44', '#f0e4c8'] }],
  ['palffy', 'Pálffyho palác', [/^Pálffyho palác$/], { near: [-423, -195] }],
  ['ganymede', 'Ganymedova fontána', [/^Ganymedova fontána$/]],
  ['vodnaveza', 'Vodná veža', [/^Vodná veža$/], { near: [-866, 79], ok: isPlace }],
  ['mikulas', 'Kostol sv. Mikuláša', [/^Kostol svätého Mikuláša$/], { style: ['#5c8a73', '#efe8da'] }],
  ['chatam', 'Mauzóleum Chatama Sofera', [/^Mauzóleum Chatama Sofera$/]],
  ['snm', 'Slovenské národné múzeum', [/^Slovenské národné múzeum$/], { style: ['#7d8b92', '#e8dcc2'] }],
  ['uk', 'Univerzita Komenského', [/^Univerzita Komenského$/], { ok: (t) => !!t.historic, style: ['#7d8b92', '#ece2cc'] }],
  // around Námestie SNP and Kamenné
  ['snpsquare', 'Námestie SNP', [/^Námestie SNP$/], { ok: (t) => t.place === 'square' }],
  ['manderlak', 'Manderlák', [/^Obchodný a obytný dom Manderla$/], { style: ['#9b9b95', '#d9d2c3'] }],
  ['kyjev', 'Hotel Kyjev', [/^Hotel Kyjev$/]],
  ['synagogue', 'Synagóga', [/^Ortodoxná synagóga$/], { style: ['#6b7075', '#ece6da'] }],
  ['trinity', 'Trinitársky kostol', [/^Kostol svätého Jána z Mathy$/], { style: ['#6a5040', '#f1e6cf'] }],
  ['capuchin', 'Kapucínsky kostol', [/^Kostol svätého Štefana$/], { near: [-536, -487] }],
  ['lutheran', 'Veľký evanjelický kostol', [/^Veľký evanjelický kostol$/], { style: ['#6f6a64', '#ece6d8'] }],
  // up the hill: Hodžovo námestie, Slavín, the Radio, the national bank
  ['hodzovo', 'Hodžovo námestie', [/^Hodžovo námestie$/], { near: [-360, -800] }],
  ['medicka', 'Medická záhrada', [/^Medická záhrada$/], { ok: (t) => t.leisure === 'park' }],
  ['blumental', 'Blumentálsky kostol', [/^Kostol Nanebovzatia Panny Márie$/], { near: [485, -1325] }],
  ['slavin', 'Slavín', [/^Slavín$/], { ok: (t) => !!t.building }],
  ['radio', 'Slovenský rozhlas', [/^Slovenský rozhlas$/], { ok: (t) => !!t.building, style: ['#6e5a4e', '#8a6a55'], shape: 10 }],
  ['nbs', 'Národná banka Slovenska', [/^Národná banka Slovenska$/], { ok: (t) => !!t.building, style: ['#a9b3ba', '#8ea1ad'] }],
  // the new downtown on the river
  ['newsnd', 'Nové SND', [/^Slovenské národné divadlo$/], { near: [819, -42] }],
  ['euroveatower', 'Eurovea Tower', [/^Eurovea Tower$/], { style: ['#c7cdd1', '#7d98ab'] }],
  ['panorama', 'Panorama City', [/^Panorama Towers$/]],
  ['skypark', 'Sky Park', [/^Sky Park$/], { near: [954, -329] }],
  ['nivytower', 'Nivy Tower', [/^Nivy Tower$/]],
  // Petržalka
  ['incheba', 'Incheba', [/^Incheba Expo Bratislava$/, /^Incheba tower$/]],
];
const landmarks = [];
/** where an element is: a node's position, a way's centroid, a relation's outer ways' centroid */
function elementAt(type, el) {
  if (type === 'relation') {
    const outer = el.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref)).filter(Boolean);
    const pts = outer.flatMap(wayPts);
    return pts.length ? centroid(pts) : null;
  }
  return elemPos(type, el);
}
for (const [id, label, patterns, opt = {}] of LANDMARKS) {
  let found = null;
  for (const re of patterns) {
    let best = null, bestD = Infinity;
    for (const [type, map] of [['way', ways], ['node', nodes], ['relation', rels]]) {
      for (const el of map.values()) {
        if (!el.tags?.name || !re.test(el.tags.name) || (opt.ok && !opt.ok(el.tags))) continue;
        const p = elementAt(type, el);
        if (!p || !inView([p])) continue;
        const d = opt.near ? Math.hypot(p[0] - opt.near[0], p[1] - opt.near[1]) : 0;
        if (d < bestD) (bestD = d), (best = p);
        if (!opt.near) break;
      }
      if (best && !opt.near) break;
    }
    if (best && (!opt.near || bestD < 250)) {
      found = best;
      break;
    }
  }
  if (found) landmarks.push({ id, n: label, x: r1(found[0]), y: r1(found[1]) });
  else console.warn(`landmark not found: ${label}`);
}

// Real-world colours for landmark buildings: [roof, walls], also for their parts (unless the map
// colours a part itself, like the cathedral's copper spire)
for (const l of landmarks) {
  const style = LANDMARKS.find((d) => d[0] === l.id)?.[3]?.style;
  if (!style) continue;
  let best = null, bestScore = Infinity;
  for (const b of buildings) {
    if (b.k === 5 || b.p) continue;
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
    const [roof, wall] = style;
    for (const b of buildings) {
      if (b !== best && b.parent !== best) continue;
      if (b === best || !b.ownRoof) b.c = roof;
      if (b === best || !b.ownWall) b.w = wall;
      b.k = b.k === 1 ? 1 : b.k === 4 || b.k === 6 ? b.k : 2;
    }
    // the Slovak Radio stands on its point: an inverted pyramid (see BuildingJSON.rs)
    const shape = LANDMARKS.find((d) => d[0] === l.id)?.[3]?.shape;
    if (shape) best.rs = shape;
  } else console.warn(`no building for landmark ${l.id}`);
}

/** Does a polyline cross a fountain's rim? */
const rimGrid = new Grid(16);
for (const r of fountainRims) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) (x0 = Math.min(x0, r[i])), (x1 = Math.max(x1, r[i])), (y0 = Math.min(y0, r[i + 1])), (y1 = Math.max(y1, r[i + 1]));
  rimGrid.add({ r }, x0, y0, x1, y1);
}
function crossesFountain(pts) {
  let hit = false;
  for (let i = 1; i < pts.length && !hit; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    rimGrid.query(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), ({ r }) => {
      for (let j = 0; !hit && j < r.length - 2; j += 2) if (segIntersect(ax, ay, bx, by, r[j], r[j + 1], r[j + 2], r[j + 3]) >= 0) hit = true;
    });
  }
  return hit;
}

/** Split every drivable way at the bollard rows that close it. Each side ends in its own dead end
 *  a couple of metres short of the row (a new node), so traffic never routes through or up to it. */
function cutAtClosures(list) {
  const out = [];
  let copies = 0;
  /** a dead end STOP metres from the row towards `toward` (null when that's too close to keep) */
  const STOP = 2.5;
  const stub = (row, toward) => {
    const [tx, ty] = xy(toward);
    const d = Math.hypot(tx - row.x, ty - row.y);
    if (d < STOP + 1) return null;
    const id = `stub${copies++}`;
    nodes.set(id, nodes.get(toward));
    nodeXY.set(id, [row.x + ((tx - row.x) * STOP) / d, row.y + ((ty - row.y) * STOP) / d]);
    return id;
  };
  const cuts = (n, w) => closesWay(n, w) || (gatesAt.get(n)?.ways.has(w) ?? false);
  for (const e of list) {
    const nds = e.w.nds.filter((n) => nodes.has(n));
    if (!nds.some((n) => cuts(n, e.w))) {
      out.push(e);
      continue;
    }
    let piece = [];
    for (let i = 0; i < nds.length; i++) {
      const n = nds[i];
      if (!cuts(n, e.w)) {
        piece.push(n);
        continue;
      }
      const row = closes.get(n) ?? gatesAt.get(n);
      // end the piece so far short of the row, and start the next one past it
      if (piece.length) {
        const end = stub(row, piece[piece.length - 1]);
        if (end) piece.push(end);
        if (piece.length >= 2) out.push({ ...e, w: { nds: piece, tags: e.w.tags } });
      }
      piece = [];
      if (i + 1 < nds.length) {
        const start = stub(row, nds[i + 1]);
        if (start) piece.push(start);
      }
    }
    if (piece.length >= 2) out.push({ ...e, w: { nds: piece, tags: e.w.tags } });
  }
  return out;
}
const car = buildGraph(cutAtClosures(graphWays.car));
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
  posts,
  trees,
  lamps,
  crossings,
  signals,
  tramStops,
  tramStopNames,
  rails,
  islands,
  gates,
  supports,
  calming,
  yields,
  furniture,
  places,
  districts,
  quarters,
  squares,
  flagsUntagged: 1,
};
// Bake the lanes and walking lines the game fits to the streets (World.fitLanes/fitWalks: traffic
// keeps as far right as each street allows, people walk where there's room), so clients and the
// server don't spend a few hundred milliseconds on it at startup: run the game's own World on the
// finished map and store the offsets that differ from the defaults.
{
  const { build } = await import('esbuild');
  const out = await build({ entryPoints: [fileURLToPath(new URL('../src/shared/world/World.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'warning' });
  const { World } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
  const t = performance.now();
  new World(map).bakeFits(map);
  const nLanes = map.graph.car.edges.filter((e) => e.lf !== undefined || e.lr !== undefined).length;
  const nWalks = map.graph.ped.edges.filter((e) => e.wr !== undefined || e.wl !== undefined).length;
  console.log(`fitted in ${Math.round(performance.now() - t)} ms: ${nLanes} lanes moved off their default, ${nWalks} walking lines, ${map.graph.ped.edges.filter((e) => e.nw).length} ways nobody walks`);
}

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
