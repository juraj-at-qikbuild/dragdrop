// The shops' words (src/game/features/shops/text.ts; docs/plans/gameplay.md, Phase 2) and the police
// describing someone on foot by their clothes (src/game/features/police/text.ts). Node environment
// (vitest.config.ts): the panels themselves are DOM, checked in the browser (scripts/smoke.mjs).
import { describe, expect, it } from 'vitest';
import {
  GUN_NAME, HAT_NAMES, JACKET_NAMES, MOD_INFO, MOD_KEYS, NEON_NAMES, SHOP_KIND, ammoLine, collectionLine, condition, distanceLine, gunLine, modName, modsLine,
  paintName, placesWord, storedCarLine,
} from '../../src/game/features/shops/text';
import { DISPATCH, describeClothes, describeWalker, wantedLine } from '../../src/game/features/police/text';
import { COLLECTION, HATS, MOD_MAX, NEONS, NO_MODS, PAINTS } from '../../src/shared/sim/shops/catalog';
import { PLAYER_SHIRTS } from '../../src/shared/entities/Ped';

describe("the shops' words", () => {
  it('names every jacket, hat, neon and paint on offer', () => {
    expect(JACKET_NAMES).toHaveLength(PLAYER_SHIRTS.length);
    expect(JACKET_NAMES.slice(0, 5)).toEqual(['Hnedá', 'Modrá', 'Zelená', 'Fialová', 'Červená']);
    expect(HAT_NAMES).toHaveLength(HATS.length);
    expect(NEON_NAMES).toHaveLength(NEONS.length);
    for (const c of PAINTS) expect(paintName(c)).toMatch(/^\p{Lu}\p{Ll}+ lak$/u);
    expect(paintName('#c62828')).toBe('Červený lak');
    expect(paintName('#eeeeee')).toBe('Biely lak');
    expect(paintName('#212121')).toBe('Čierny lak');
  });

  it('every kind of shop says what it is; every toy and upgrade has a name', () => {
    for (const k of ['guns', 'clothes', 'lawyer', 'tuning', 'garage', 'teleport'] as const) expect(SHOP_KIND[k].name && SHOP_KIND[k].about).toBeTruthy();
    // the toy shop (docs/plans/non-violent.md): toys and refills, not guns and bullets
    expect(SHOP_KIND.guns.name).toBe('Hračkárstvo');
    expect(Object.keys(GUN_NAME)).toEqual(['pistol', 'uzi', 'shotgun']);
    expect(MOD_KEYS.every((k) => MOD_INFO[k].name && MOD_MAX[k] >= 1)).toBe(true);
    expect(gunLine('pistol')).toBe('Vodná pištoľ + 36 striekancov');
    expect(gunLine('uzi')).toBe('Bublinkový samopal + 120 bubliniek');
    expect(gunLine('shotgun')).toBe('Konfetová brokovnica + 16 dávok konfiet');
    expect(ammoLine('pistol', 1)).toBe('1 striekanec');
    expect(ammoLine('uzi', 3)).toBe('3 bublinky');
    expect(ammoLine('shotgun', 1)).toBe('1 dávka konfiet');
  });

  it("a car's tuning, and a car in the garage, in one line", () => {
    expect(modsLine(NO_MODS)).toBe('Sériové');
    expect(modsLine({ engine: 2, plating: 1, tyres: 1, nitro: 2, glow: 3 })).toBe('Motor II · Pancier I · Dojazdové pneu · Nitro II · Neón');
    expect(modName('engine', 1)).toBe('Motor I');
    expect(modName('tyres', 1)).toBe('Dojazdové pneumatiky');
    expect(storedCarLine({ kind: 'hatch', color: '#fff', mods: NO_MODS, hp: 50, dmg: [0, 0, 0, 0] })).toBe('Škodovka Felícia · 50 %');
    expect(storedCarLine({ kind: 'sport', color: '#fff', mods: { ...NO_MODS, engine: 1 }, hp: 90, dmg: [0, 0, 0, 0] })).toBe('Porše 911 Blava · 100 % · Motor I');
    expect(condition('hatch', 0.2)).toBe(1);
  });

  it("says how far each teleport is", () => {
    expect([40, 320, 949, 974, 975, 2440].map(distanceLine)).toEqual(['50 m', '300 m', '950 m', '950 m', '1,0 km', '2,4 km']);
  });

  it('counts garage places and the collection', () => {
    expect([2, 4, 6].map(placesWord)).toEqual(['2 miesta', '4 miesta', '6 miest']);
    expect(collectionLine(undefined)).toBe(`Zbierka 0/${COLLECTION.length}`);
    expect(collectionLine(['hatch', 'bus', 'ufo'])).toBe(`Zbierka 2/${COLLECTION.length}`);
  });
});

describe('the police look for clothes', () => {
  it('the jacket and the hat, declined as the sentence needs them', () => {
    expect(describeClothes('#1565c0')).toBe('modrú bundu');
    expect(describeClothes('#1565c0', 1)).toBe('modrú bundu so šiltovkou');
    expect(describeClothes('#4a3220', 2)).toBe('hnedú bundu s klobúkom');
    expect(wantedLine(0, '', '#c62828', 3)).toBe('Hľadajú červenú bundu s prilbou');
    expect(describeWalker('#2e7d32', 4)).toBe('pešieho podozrivého v zelenej bunde so šatkou');
    expect(describeWalker('#eeeeee')).toBe('pešieho podozrivého v bielej bunde');
    expect(describeWalker('')).toBe('pešieho podozrivého');
    expect(DISPATCH.changed('modrú bundu')).toBe('Pozor, podozrivý sa prezliekol! Hľadáme modrú bundu.');
  });

  it("a jacket's name in the Butik is the colour the police will say", () => {
    PLAYER_SHIRTS.forEach((c, i) => {
      const adj = describeClothes(c).split(' ')[0];
      // "Modrá" in the shop, "modrú bundu" on the radio: the same stem
      expect(JACKET_NAMES[i].toLowerCase().slice(0, -1)).toBe(adj.slice(0, -1));
    });
  });
});
