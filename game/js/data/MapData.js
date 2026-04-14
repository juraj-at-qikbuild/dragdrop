// Tile IDs:
// 0 = grass
// 1 = sidewalk
// 2 = road (horizontal)
// 3 = road (vertical)
// 4 = intersection
// 5 = building (collision)
// 6 = pavement/lot

// 64x64 tile map (each tile = 32px => 2048x2048 world)
// Layout: roads every 12 tiles (10 tile blocks + 2 road tiles)
// Block pattern: 2-road, 10-block, 2-road, 10-block, ...

const TILE = {
  GRASS: 0,
  SIDEWALK: 1,
  ROAD_H: 2,
  ROAD_V: 3,
  INTERSECTION: 4,
  BUILDING: 5,
  LOT: 6,
};

// Helper to generate the 64x64 map
function generateCityMap() {
  const SIZE = 64;
  const map = [];

  // Road positions (columns for vertical roads, rows for horizontal roads)
  const roadCols = [0, 1, 12, 13, 24, 25, 36, 37, 48, 49, 62, 63];
  const roadRows = [0, 1, 12, 13, 24, 25, 36, 37, 48, 49, 62, 63];

  const isRoadCol = (c) => roadCols.includes(c);
  const isRoadRow = (r) => roadRows.includes(r);

  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      const onRoadRow = isRoadRow(r);
      const onRoadCol = isRoadCol(c);

      if (onRoadRow && onRoadCol) {
        row.push(TILE.INTERSECTION);
      } else if (onRoadRow) {
        row.push(TILE.ROAD_H);
      } else if (onRoadCol) {
        row.push(TILE.ROAD_V);
      } else {
        // Inside a block: sidewalk border (1 tile) then building interior
        // Block boundaries
        const blockStartC = roadCols.reduce((acc, rc) => rc < c ? rc + 1 : acc, 0);
        const blockStartR = roadRows.reduce((acc, rr) => rr < r ? rr + 1 : acc, 0);
        const blockEndC = roadCols.find(rc => rc > c) - 1;
        const blockEndR = roadRows.find(rr => rr > r) - 1;

        const onSidewalk =
          c === blockStartC || c === blockEndC ||
          r === blockStartR || r === blockEndR;

        if (onSidewalk) {
          row.push(TILE.SIDEWALK);
        } else {
          // Some blocks are open lots / parks for variety
          const blockId = Math.floor(c / 12) + Math.floor(r / 12) * 5;
          // Every 5th block is an open lot
          if (blockId % 7 === 3) {
            row.push(TILE.LOT);
          } else {
            row.push(TILE.BUILDING);
          }
        }
      }
    }
    map.push(row);
  }

  return map;
}

const MAP_DATA = generateCityMap();

// Spawn points: positions (in tile coords) for various entities
const SPAWN_POINTS = {
  player: { tx: 3, ty: 3 },           // near top-left intersection

  vehicles: [
    { tx: 5, ty: 1, type: 'sedan' },
    { tx: 8, ty: 1, type: 'sedan' },
    { tx: 15, ty: 1, type: 'truck' },
    { tx: 5, ty: 13, type: 'sedan' },
    { tx: 18, ty: 13, type: 'sedan' },
    { tx: 27, ty: 1, type: 'sedan' },
    { tx: 30, ty: 25, type: 'truck' },
    { tx: 40, ty: 13, type: 'sedan' },
    { tx: 50, ty: 1, type: 'sedan' },
    { tx: 55, ty: 25, type: 'sedan' },
  ],

  pedestrians: [
    { tx: 3, ty: 3 }, { tx: 4, ty: 3 }, { tx: 3, ty: 4 },
    { tx: 14, ty: 3 }, { tx: 15, ty: 3 }, { tx: 14, ty: 4 },
    { tx: 26, ty: 3 }, { tx: 27, ty: 3 },
    { tx: 3, ty: 14 }, { tx: 4, ty: 14 },
    { tx: 14, ty: 14 }, { tx: 15, ty: 14 },
    { tx: 26, ty: 14 }, { tx: 27, ty: 14 },
    { tx: 38, ty: 3 }, { tx: 39, ty: 3 },
    { tx: 50, ty: 3 }, { tx: 51, ty: 3 },
  ],

  // Gang territories: top-left quadrant = Loonies, top-right = Zaibatsu, bottom = Rednecks
  gangMembers: [
    // Loonies (top-left)
    { tx: 5, ty: 5, gang: 'loonies' },
    { tx: 7, ty: 5, gang: 'loonies' },
    { tx: 5, ty: 7, gang: 'loonies' },
    { tx: 16, ty: 5, gang: 'loonies' },
    { tx: 18, ty: 5, gang: 'loonies' },
    // Zaibatsu (top-right)
    { tx: 38, ty: 5, gang: 'zaibatsu' },
    { tx: 40, ty: 5, gang: 'zaibatsu' },
    { tx: 38, ty: 7, gang: 'zaibatsu' },
    { tx: 50, ty: 5, gang: 'zaibatsu' },
    { tx: 52, ty: 5, gang: 'zaibatsu' },
    // Rednecks (bottom)
    { tx: 5, ty: 38, gang: 'rednecks' },
    { tx: 7, ty: 38, gang: 'rednecks' },
    { tx: 5, ty: 40, gang: 'rednecks' },
    { tx: 38, ty: 38, gang: 'rednecks' },
    { tx: 40, ty: 38, gang: 'rednecks' },
  ],

  weaponPickups: [
    { tx: 3, ty: 6, weaponId: 'pistol' },
    { tx: 14, ty: 6, weaponId: 'pistol' },
    { tx: 26, ty: 6, weaponId: 'shotgun' },
    { tx: 38, ty: 6, weaponId: 'pistol' },
    { tx: 50, ty: 6, weaponId: 'shotgun' },
    { tx: 3, ty: 26, weaponId: 'machineGun' },
    { tx: 14, ty: 26, weaponId: 'pistol' },
    { tx: 26, ty: 26, weaponId: 'shotgun' },
    { tx: 38, ty: 26, weaponId: 'machineGun' },
    { tx: 50, ty: 26, weaponId: 'pistol' },
    { tx: 3, ty: 50, weaponId: 'shotgun' },
    { tx: 26, ty: 50, weaponId: 'machineGun' },
    { tx: 50, ty: 50, weaponId: 'pistol' },
  ],

  phoneBooths: [
    { tx: 11, ty: 3, missionId: 'loonies_1' },
    { tx: 23, ty: 3, missionId: 'zaibatsu_1' },
    { tx: 11, ty: 25, missionId: 'rednecks_1' },
  ],
};

const MAP_TILE_SIZE = 32;
const MAP_WIDTH = 64;
const MAP_HEIGHT = 64;
const MAP_WORLD_WIDTH = MAP_WIDTH * MAP_TILE_SIZE;
const MAP_WORLD_HEIGHT = MAP_HEIGHT * MAP_TILE_SIZE;
