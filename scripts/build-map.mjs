// Converts the raw OSM tiles in .cache/osm into a compact game map:
// public/data/bratislava.json  (all coordinates in metres, origin at map centre,
// +x = east, +y = south).
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { BBOX } from './bbox.mjs';

const SRC = new URL('../.cache/osm/', import.meta.url);
const OUT = new URL('../public/data/bratislava.json', import.meta.url);

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
const centroid = (pts) => {
  let x = 0, y = 0;
  for (const p of pts) (x += p[0]), (y += p[1]);
  return [x / pts.length, y / pts.length];
};

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
const areas = { water: [], green: [], wood: [], plaza: [], parking: [], pitch: [], sand: [], rail: [] };
const pois = [];

function roadWidth(t, cls) {
  const w = parseFloat(t.width);
  if (w > 1 && w < 40) return w;
  const lanes = parseInt(t.lanes);
  if (lanes > 0 && cls <= 5) return Math.min(24, lanes * 3.3 + 1.5);
  return DEFAULT_WIDTH[cls];
}

function areaKind(t) {
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

function buildingInfo(t) {
  let levels = parseFloat(t['building:levels']);
  const h = parseFloat(t.height);
  const small = ['garage', 'garages', 'shed', 'kiosk', 'roof', 'hut'].includes(t.building);
  // no height at all: default to 3 storeys and flag it, so the game can vary untagged heights
  const untagged = !(levels > 0) && !(h > 0) && !small;
  if (!(levels > 0)) levels = h > 0 ? h / 3.2 : small ? 1 : 3;
  let kind = 0; // 0 normal, 1 church, 2 castle/landmark, 3 industrial, 4 roof/shelter
  if (['church', 'cathedral', 'chapel'].includes(t.building) || t.amenity === 'place_of_worship') kind = 1;
  if (t.historic === 'castle' || t.building === 'castle' || t.historic === 'city_gate') kind = 2;
  if (['industrial', 'warehouse', 'retail', 'commercial'].includes(t.building)) kind = 3;
  if (['roof', 'canopy', 'carport'].includes(t.building)) kind = 4;
  return { levels: Math.min(40, Math.max(1, levels)), kind, untagged };
}

function addBuilding(rings, t, id) {
  if (t.building === 'no' || t['building:part'] || t.location === 'underground' || t.layer < 0) return;
  const rs = rings.map((r) => simplify(r, 0.25)).filter((r) => r.length >= 4);
  if (!rs.length || !inView(rs[0])) return;
  const { levels, kind, untagged } = buildingInfo(t);
  const b = { r: rs.map(flat), l: Math.round(levels * 10) / 10, k: kind, s: id % 997 };
  if (untagged) b.u = 1;
  if (t.name) b.n = nameId(t.name);
  buildings.push(b);
}

function addArea(kind, rings) {
  const rs = rings.map((r) => simplify(r, 0.8)).filter((r) => r.length >= 4 && inView(r));
  if (!rs.length) return;
  areas[kind].push(rs.map(flat));
}

// ways
const graphWays = { car: [], ped: [], tram: [] };
for (const [id, w] of ways) {
  const t = w.tags;
  if (!Object.keys(t).length) continue;
  const pts = wayPts(w);
  if (pts.length < 2 || !inView(pts)) continue;
  const closed = w.nds[0] === w.nds[w.nds.length - 1];

  if (t.highway && ROAD_CLASS[t.highway] !== undefined && t.area !== 'yes') {
    if (t.tunnel === 'yes' || t.tunnel === 'building_passage' && false) {
      // tunnels are not rendered and are not part of the playable network
    } else {
      const c = ROAD_CLASS[t.highway];
      const road = { p: flat(simplify(pts, 0.4)), c, w: r1(roadWidth(t, c)) };
      if (t.name) road.n = nameId(t.name);
      if (t.bridge && t.bridge !== 'no') road.b = 1;
      if (t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout') road.o = 1;
      if (t.oneway === '-1') road.o = -1;
      if (+t.layer) road.y = +t.layer;
      roads.push(road);
      if (DRIVABLE.has(c) && t.access !== 'no' && t.motor_vehicle !== 'no' && t.service !== 'parking_aisle' && t.service !== 'driveway')
        graphWays.car.push({ w, c, oneway: road.o ?? 0, width: road.w, name: road.n ?? -1 });
      if (c >= 2 && t.foot !== 'no')
        graphWays.ped.push({ w, c, oneway: 0, width: road.w, name: road.n ?? -1 });
    }
  }
  if (t.railway === 'tram' && t.tunnel !== 'yes') {
    trams.push(flat(simplify(pts, 0.3)));
    graphWays.tram.push({ w, c: 0, oneway: 0, width: 3, name: -1 });
  }
  if (closed) {
    if (t.building) addBuilding([pts], t, +id);
    const kind = areaKind(t);
    if (kind) addArea(kind, [pts]);
  }
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
  for (const { w, c, oneway, width, name } of list) {
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
function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
for (const l of landmarks) {
  const style = LANDMARK_STYLE[l.id];
  if (!style) continue;
  let best = null, bestScore = Infinity;
  for (const b of buildings) {
    const r = b.r[0];
    let cx = 0, cy = 0;
    for (let i = 0; i < r.length; i += 2) (cx += r[i]), (cy += r[i + 1]);
    cx /= r.length / 2;
    cy /= r.length / 2;
    const d = Math.hypot(cx - l.x, cy - l.y);
    const score = pointInRing(l.x, l.y, r) ? -polyArea(Array.from({ length: r.length / 2 }, (_, i) => [r[i * 2], r[i * 2 + 1]])) : d;
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
for (const e of car.edges) e.s = SPEED[e.c] ?? 8;

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
  flagsUntagged: 1,
};
await mkdir(new URL('.', OUT), { recursive: true });
const json = JSON.stringify(map);
await writeFile(OUT, json);
console.log(
  `wrote ${(json.length / 1e6).toFixed(2)} MB: ${roads.length} roads, ${buildings.length} buildings, ` +
    Object.entries(areas).map(([k, v]) => `${v.length} ${k}`).join(', ') +
    `, ${trams.length} tram ways, ${pois.length} pois, ${landmarks.length} landmarks, ` +
    `car graph ${car.nodes.length / 2}n/${car.edges.length}e, ped ${ped.edges.length}e, tram ${tram.edges.length}e`,
);
