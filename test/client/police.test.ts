// What the police are looking for, in Slovak (src/game/features/police/text.ts): colours read off
// the cars' paint, adjectives declined for each model, and the chip's first line.
import { describe, expect, it } from 'vitest';
import { colorIndex, describeCar, nameCar, wantedLine } from '../../src/game/features/police/text';
import { SPECS, type VehicleKind } from '../../src/shared/entities/Vehicle';

describe('colorIndex', () => {
  it('reads the cars\' paints the way a witness would', () => {
    const name = (hex: string) => ['čierna', 'sivá', 'biela', 'červená', 'oranžová', 'žltá', 'zelená', 'tyrkysová', 'modrá', 'fialová', 'ružová', 'hnedá'][colorIndex(hex)];
    expect(name('#c62828')).toBe('červená');
    expect(name('#d50000')).toBe('červená');
    expect(name('#1565c0')).toBe('modrá');
    expect(name('#1a237e')).toBe('modrá');
    expect(name('#2e7d32')).toBe('zelená');
    expect(name('#f9a825')).toBe('žltá');
    expect(name('#fdd835')).toBe('žltá');
    expect(name('#ff6f00')).toBe('oranžová');
    expect(name('#00bfa5')).toBe('tyrkysová');
    expect(name('#8e24aa')).toBe('fialová');
    expect(name('#7b1fa2')).toBe('fialová');
    expect(name('#6d4c41')).toBe('hnedá');
    expect(name('#4e342e')).toBe('hnedá');
    expect(name('#eeeeee')).toBe('biela');
    expect(name('#fafafa')).toBe('biela');
    expect(name('#b0bec5')).toBe('sivá');
    expect(name('#455a64')).toBe('sivá');
    expect(name('#212121')).toBe('čierna');
    expect(name('#111111')).toBe('čierna');
    expect(name('#263238')).toBe('čierna');
  });

  it('names every paint a car can have', () => {
    for (const k of Object.keys(SPECS) as VehicleKind[])
      for (const c of SPECS[k].colors) expect(describeCar(k, c)).toMatch(/^[a-zžščťďňľáéíóúýôä ]+/i);
  });
});

describe('describeCar / nameCar', () => {
  it('declines the colour for each model: whom they look for, and what it is', () => {
    expect(describeCar('hatch', '#c62828')).toBe('červenú Felíciu');
    expect(describeCar('sedan', '#eeeeee')).toBe('bielu Octávku');
    expect(describeCar('classic', '#111111')).toBe('čiernu Tatrovku');
    expect(describeCar('bus', '#d71920')).toBe('červený autobus');
    expect(describeCar('bus', '#eeeeee')).toBe('biely autobus');
    expect(describeCar('sport', '#ff6f00')).toBe('oranžové Porše');
    expect(describeCar('sport', '#fafafa')).toBe('biele Porše');
    expect(describeCar('taxi', '#fdd835')).toBe('žltý taxík');
    expect(describeCar('van', '#1e88e5')).toBe('modrú dodávku');
    expect(describeCar('police', '#f5f5f5')).toBe('policajnú Octávku');
    expect(nameCar('hatch', '#c62828')).toBe('červená Felícia');
    expect(nameCar('sedan', '#eeeeee')).toBe('biela Octávka');
  });

  it('says who they look for on the chip, on foot too', () => {
    expect(wantedLine(0, '', '')).toBe('Hľadajú ťa pešo');
    expect(wantedLine(12, 'hatch', '#1565c0')).toBe('Hľadajú modrú Felíciu');
  });
});
