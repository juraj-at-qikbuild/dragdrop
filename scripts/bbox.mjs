// Playable area: Bratislava Old Town, the castle hill up to Slavín and the Slovak Radio, the Danube
// riverside and the northern edge of Petržalka.
export const BBOX = { minLon: 17.09, minLat: 48.13, maxLon: 17.135, maxLat: 48.1555 };
// Where the map's local metres are measured from (x east, y south). Fixed on its own, so growing the
// area doesn't move anything already on the map (tests, missions and saves refer to places by
// position): the centre of the original 17.09-17.135 / 48.13-48.152 box.
export const ORIGIN = { lat: 48.141, lon: 17.1125 };

/** The OSM API rejects big boxes, so the area is downloaded in tiles this many degrees across. */
export const TILE_STEP = 0.005;

/** Every download tile: its bounding box (clipped to BBOX) and its cache file name, which carries
 *  the box, so growing BBOX re-downloads the clipped edge tiles instead of reusing stale ones. */
export function tiles() {
  const out = [];
  for (let lon = BBOX.minLon; lon < BBOX.maxLon - 1e-9; lon += TILE_STEP)
    for (let lat = BBOX.minLat; lat < BBOX.maxLat - 1e-9; lat += TILE_STEP) {
      const box = [lon, lat, Math.min(lon + TILE_STEP, BBOX.maxLon), Math.min(lat + TILE_STEP, BBOX.maxLat)].map((v) => v.toFixed(4));
      out.push({ bbox: box.join(','), file: `${box.join('_')}.osm` });
    }
  return out;
}
