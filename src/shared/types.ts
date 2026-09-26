// Shape of public/data/bratislava.json, produced by scripts/build-map.mjs.
// Coordinates are metres from the map centre, +x east, +y south.

export interface RoadJSON {
  p: number[]; // flat [x0,y0,x1,y1,...]
  c: number; // road class, see RoadClass
  w: number; // width in metres
  n?: number; // name index
  b?: 1; // bridge
  o?: 1 | -1; // oneway
  y?: number; // layer
  l?: number; // marked lanes (both ways together)
  lf?: [number, number]; // ...of which forward, backward (when the map says)
  s?: 1 | 2; // paving of a car road: 1 setts / cobblestones, 2 paving stones
}

export interface BuildingJSON {
  r: number[][]; // rings (outer first, then courtyards)
  l: number; // levels (to the top of the building)
  k: number; // kind: 0 normal, 1 church, 2 castle / historic, 3 commercial, 4 roof, 5 tower structure drawn by the game (Most SNP pylon, UFO), 6 monument (plain stone)
  s: number; // seed
  n?: number;
  c?: string; // roof colour override
  w?: string; // wall colour override
  u?: 1; // levels untagged in OSM (defaulted to 3); only set when the map has `flagsUntagged`
  m?: number; // raised: metres above the ground where it starts (min_height); nothing solid stands below it
  rs?: number; // roof shape: 1 flat, 2 gabled, 3 hipped, 4 pyramidal, 5 dome, 6 onion, 7 round, 8 skillion, 9 cone, 10 an inverted pyramid: the whole building overhangs its foot (the Slovak Radio) (0 / absent: the game decides)
  rh?: number; // height (m) of a pyramid, dome, onion or cone roof on top of the walls (`l` is the walls' height then)
  p?: 1; // a building part (a tower, a spire, a wing): drawn, never solid; its building's outline is the obstacle
  x?: 1; // an outline whose parts are drawn instead of it (still solid)
}

/** A public road tunnel tube or the tram tunnel: centre line, width, 0 road / 1 tram, which ends are portals to the surface. */
export interface TunnelJSON {
  p: number[];
  w: number;
  k: 0 | 1;
  o: [0 | 1, 0 | 1];
}

/** A street or path running through a building (gateway, courtyard passage, covered road): centre line and width. */
export interface PassageJSON {
  p: number[];
  w: number;
}

/** A wall, fence or hedge piece (already opened where streets and gates cross it); `k` indexes World.BARRIERS. */
export interface BarrierJSON {
  p: number[];
  k: number;
}

export interface EdgeJSON {
  a: number;
  b: number;
  p: number[];
  c: number;
  w: number;
  o?: 1 | -1;
  n?: number;
  s?: number; // speed m/s (car graph)
  x?: 1; // pedestrian graph: bollards or blocks across it stop cars
  ln?: [number, number]; // car graph: marked lanes a -> b and b -> a, when there's a choice (2+ one way)
  r?: number; // tram graph: bit mask of the tram lines (1 << line number) running along it
  // baked by the map builder from World's fitting (see MapJSON.fit), only where not the default:
  lf?: number; // car graph: lane offset a -> b
  lr?: number; // car graph: lane offset b -> a
  bf?: 1; // car graph: that lane runs into a building
  br?: 1;
  wr?: number; // pedestrian graph: walking line offset right of a -> b
  wl?: number; // ...and left of it
  nw?: 1; // pedestrian graph: nobody walks it
}

export interface GraphJSON {
  nodes: number[];
  edges: EdgeJSON[];
}

export interface MapJSON {
  bounds: [number, number, number, number];
  origin: [number, number];
  names: string[];
  roads: RoadJSON[];
  trams: number[][];
  buildings: BuildingJSON[];
  areas: Record<'water' | 'green' | 'wood' | 'plaza' | 'parking' | 'pitch' | 'sand' | 'rail', number[][][]> & { pier?: number[][][] };
  rivers: { p: number[]; n: number }[];
  pois: { k: 'police' | 'hospital' | 'fuel' | 'shop'; x: number; y: number; n: string }[];
  landmarks: { id: string; n: string; x: number; y: number }[];
  graph: { car: GraphJSON; ped: GraphJSON; tram: GraphJSON };
  /** 1 when buildings carry the `u` (untagged levels) flag; older maps predate it */
  flagsUntagged?: 1;
  // Everything below is absent from maps built before these features (the game then falls back
  // to its procedural guesses).
  tunnels?: TunnelJSON[];
  passages?: PassageJSON[];
  barriers?: BarrierJSON[];
  /** real trees, flat [x, y, ...] */
  trees?: number[];
  /** real street lamps, flat [x, y, ...] */
  lamps?: number[];
  /** marked pedestrian crossings on drivable streets, flat [x, y, street direction, street width, ...] */
  crossings?: number[];
  /** traffic lights, flat [x, y, street direction, applies to (0 both, 1 along, -1 against), pedestrian crossing (0/1), ...] */
  signals?: number[];
  /** tram stops on the tracks, flat [x, y, ...] */
  tramStops?: number[];
  /** railway tracks */
  rails?: { p: number[]; b?: 1 }[];
  /** solid street furniture and monuments: bollards, blocks, planters, statues, columns; flat
   *  [x, y, radius, kind, ...], `kind` indexes World.POSTS */
  posts?: number[];
  /** World.FIT_VERSION the lanes and walking lines in the graphs were baked with (else the game
   *  fits them itself at startup) */
  fit?: number;
  /** name index of each tram stop in `tramStops` (-1 unnamed) */
  tramStopNames?: number[];
  /** raised traffic islands in the carriageway: outline, grassed (g) or paved */
  islands?: { p: number[]; g?: 1 }[];
  /** lift gates (boom barriers): flat [x, y, direction of the way, boom length, ...] */
  gates?: number[];
  /** bridge piers standing on the ground or in the river: closed rings */
  supports?: number[][];
  /** speed bumps and raised tables: flat [x, y, street direction, street half-width, kind (0 bump, 1 table, 2 cushions, 3 rumble strip), ...] */
  calming?: number[];
  /** stop and give-way signs: flat [x, y, direction of the traffic they stop, street half-width, kind (0 stop, 1 give way), ...] */
  yields?: number[];
  /** street furniture: flat [x, y, angle, kind, ...], `kind` indexes World.FURNITURE */
  furniture?: number[];
  /** places by kind (food, cafe, bar, pharmacy, museum, theatre, hotel, grocery, bakery, church, bank,
   *  post, library, view, wc, taxi); `n`: name index (museums, theatres, churches, libraries) */
  places?: { k: string; x: number; y: number; n?: number }[];
  /** the city's boroughs: name index and boundary rings */
  districts?: { n: number; r: number[][] }[];
  /** named quarters and neighbourhoods: name index and label point */
  quarters?: { n: number; x: number; y: number }[];
  /** named squares: name index and outline rings */
  squares?: { n: number; r: number[][] }[];
}

export const enum RoadClass {
  Motorway = 0,
  Trunk = 1,
  Primary = 2,
  Secondary = 3,
  Tertiary = 4,
  Residential = 5,
  Living = 6,
  Service = 7,
  Pedestrian = 8,
  Footway = 9,
  Steps = 10,
}
