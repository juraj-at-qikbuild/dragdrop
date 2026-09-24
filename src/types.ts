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
  l: number; // levels
  k: number; // kind: 0 normal, 1 church, 2 castle / historic, 3 commercial, 4 roof
  s: number; // seed
  n?: number;
  c?: string; // roof colour override
  w?: string; // wall colour override
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
  areas: Record<'water' | 'green' | 'wood' | 'plaza' | 'parking' | 'pitch' | 'sand' | 'rail', number[][][]>;
  rivers: { p: number[]; n: number }[];
  pois: { k: 'police' | 'hospital' | 'fuel' | 'shop'; x: number; y: number; n: string }[];
  landmarks: { id: string; n: string; x: number; y: number }[];
  graph: { car: GraphJSON; ped: GraphJSON; tram: GraphJSON };
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
