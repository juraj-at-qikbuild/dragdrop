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
}

export interface BuildingJSON {
  r: number[][]; // rings (outer first, then courtyards)
  l: number; // levels (to the top of the building)
  k: number; // kind: 0 normal, 1 church, 2 castle / historic, 3 commercial, 4 roof, 5 tower structure drawn by the game (Most SNP pylon, UFO)
  s: number; // seed
  n?: number;
  c?: string; // roof colour override
  w?: string; // wall colour override
  u?: 1; // levels untagged in OSM (defaulted to 3); only set when the map has `flagsUntagged`
  m?: number; // raised: metres above the ground where it starts (min_height); nothing solid stands below it
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
