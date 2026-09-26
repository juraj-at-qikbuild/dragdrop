// Pure-logic tests for placeName (src/shared/sim/rules/placeName.ts): every real landmark has a
// locative entry, the square rule's grammar for all 24 named squares on the real map, and placeName
// end to end for a few known spots. DOM-free (environment: node, see vitest.config.ts).
import { describe, expect, it } from 'vitest';
import { loadWorld } from './helpers';
import { LANDMARK_LOCATIVE, placeName, squarePhrase } from '../../src/shared/sim/rules/placeName';

describe('LANDMARK_LOCATIVE', () => {
  it('has a locative entry for every landmark on the real map, each with a sensible preposition', () => {
    const world = loadWorld();
    // guards the "all 52 landmark ids" requirement: if the map ever grows or shrinks its landmark
    // list, this fails loudly instead of silently leaving a hole in the table.
    expect(world.landmarks.size).toBe(52);
    for (const l of world.landmarks.values()) {
      expect(LANDMARK_LOCATIVE, `missing LANDMARK_LOCATIVE entry for "${l.id}" (${l.name})`).toHaveProperty(l.id);
      expect(LANDMARK_LOCATIVE[l.id]).toMatch(/^(pri|na|v|pod) \S/);
    }
    expect(Object.keys(LANDMARK_LOCATIVE)).toHaveLength(52);
  });

  it('every landmark position resolves back to its own table entry', () => {
    const world = loadWorld();
    for (const l of world.landmarks.values()) expect(placeName(world, l.x, l.y)).toBe(LANDMARK_LOCATIVE[l.id]);
  });
});

// the real map's 24 named squares (public/data/bratislava.json `squares` + `names`) and the correct
// Slovak locative for each — this is what caught the original bug (a leading adjective left in the
// nominative: "na Hurbanovo námestí" instead of "na Hurbanovom námestí")
const EXPECTED_SQUARES: Record<string, string> = {
  'Námestie F. X. Messerschmidta': 'na Námestí F. X. Messerschmidta',
  'Nobelovo námestie': 'na Nobelovom námestí',
  'Námestie Alexandra Dubčeka': 'na Námestí Alexandra Dubčeka',
  'Rybné námestie': 'na Rybnom námestí',
  'Františkánske námestie': 'na Františkánskom námestí',
  'Hurbanovo námestie': 'na Hurbanovom námestí',
  'Župné Námestie': 'na Župnom námestí',
  'Námestie SNP': 'na Námestí SNP',
  'Námestie T. G. Masaryka': 'na Námestí T. G. Masaryka',
  'Komenského námestie': 'na Komenského námestí',
  'Námestie Nežnej revolúcie': 'na Námestí Nežnej revolúcie',
  'Šafárikovo námestie': 'na Šafárikovom námestí',
  'Námestie Martina Benku': 'na Námestí Martina Benku',
  'Kmeťovo námestie': 'na Kmeťovom námestí',
  'Dulovo námestie': 'na Dulovom námestí',
  'Daxnerovo námestie': 'na Daxnerovom námestí',
  'Rudnayovo námestie': 'na Rudnayovom námestí',
  'Hviezdoslavovo námestie': 'na Hviezdoslavovom námestí',
  'Námestie Eugena Suchoňa': 'na Námestí Eugena Suchoňa',
  'Hlavné námestie': 'na Hlavnom námestí',
  'Námestie Ľudovíta Štúra': 'na Námestí Ľudovíta Štúra',
  'Primaciálne námestie': 'na Primaciálnom námestí',
  'Hodžovo námestie': 'na Hodžovom námestí',
  'Kamenné námestie': 'na Kamennom námestí',
};

describe('squarePhrase', () => {
  it('declines all 24 named squares on the real map correctly', () => {
    const world = loadWorld();
    const squares = world.data.squares ?? [];
    const realNames = squares.map((q) => world.names[q.n]);
    expect(new Set(realNames)).toEqual(new Set(Object.keys(EXPECTED_SQUARES)));
    for (const name of realNames) expect(squarePhrase(name)).toBe(EXPECTED_SQUARES[name]);
  });

  it('leaves an unrecognised shape alone, prefixed with "na"', () => {
    expect(squarePhrase('Petržalka Plaza')).toBe('na Petržalka Plaza');
  });
});

describe('placeName', () => {
  it('names the landmark table near Most SNP and Eurovea, and a street elsewhere', () => {
    const world = loadWorld();
    const snp = world.landmark('snp');
    expect(placeName(world, snp.x, snp.y)).toBe('na Moste SNP');
    const eurovea = world.landmark('eurovea');
    expect(placeName(world, eurovea.x, eurovea.y)).toBe('pri Eurovei');
    // Vansovej, out in Karlova Ves: far from every landmark in the table, but a named street
    expect(placeName(world, -1211.3, -777.5)).toBe('na ulici Vansovej');
  });

  it('names a couple of the landmarks completed for this feature', () => {
    const world = loadWorld();
    const incheba = world.landmark('incheba');
    expect(placeName(world, incheba.x, incheba.y)).toBe('pri Inchebe');
    const uk = world.landmark('uk');
    expect(placeName(world, uk.x, uk.y)).toBe('na Univerzite Komenského');
    const kamenne = world.landmark('kamenne');
    expect(placeName(world, kamenne.x, kamenne.y)).toBe('na Kamennom námestí');
  });

  it('falls through to a named square when no landmark is close enough', () => {
    const world = loadWorld();
    const squares = world.data.squares ?? [];
    const q = squares.find((s) => world.names[s.n] === 'Nobelovo námestie')!;
    const ring = q.r[0];
    // the centroid of a real, roughly-convex square outline lands inside it
    let cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i += 2) (cx += ring[i]), (cy += ring[i + 1]);
    cx /= ring.length / 2;
    cy /= ring.length / 2;
    expect(world.squareAt(cx, cy)).toBe('Nobelovo námestie');
    expect(placeName(world, cx, cy)).toBe('na Nobelovom námestí');
  });
});
