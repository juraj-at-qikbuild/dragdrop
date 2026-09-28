import { describe, expect, it } from 'vitest';
import { forDevice } from '../../src/ui/deviceText';

describe('key names said the way the player plays', () => {
  it('leaves a keyboard player the keys', () => {
    expect(forDevice('Stojíš v boxe – zaplať v appke (B)!', 'keys')).toBe('Stojíš v boxe – zaplať v appke (B)!');
  });
  it('names the on-screen buttons on a touch screen', () => {
    expect(forDevice('Stojíš v boxe – zaplať v appke (B)!', 'touch')).toBe('Stojíš v boxe – zaplať v appke (fialové tlačidlo)!');
    expect(forDevice('Čakaj na električku a nastúp (F pri dverách).', 'touch')).toBe('Čakaj na električku a nastúp (žlté tlačidlo pri dverách).');
    expect(forDevice('Nastúp do kabíny električky – F pri jej čele.', 'touch')).toBe('Nastúp do kabíny električky – žlté tlačidlo pri jej čele.');
    expect(forDevice('postav sa na cestu a stlač B.', 'touch')).toBe('postav sa na cestu a ťukni na fialové tlačidlo.');
    expect(forDevice('Zvoň (H), odťahovka (B)', 'touch')).toBe('Zvoň (📣), odťahovka (fialové tlačidlo)');
    expect(forDevice('Revízor ťa naháňa – bež (Shift)!', 'touch')).toBe('Revízor ťa naháňa – bež (palec za okraj kruhu)!');
  });
  it('names the pad buttons with a pad', () => {
    expect(forDevice('Najprv ukonči prácu (J).', 'pad')).toBe('Najprv ukonči prácu (krížik vľavo).');
    expect(forDevice('Nasadni do auta na ihrisku (F).', 'pad')).toBe('Nasadni do auta na ihrisku (Y).');
  });
  it('leaves words that only look like keys alone', () => {
    expect(forDevice('Futbal (FC Petržalka) a Bratislava', 'touch')).toBe('Futbal (FC Petržalka) a Bratislava');
  });
});
