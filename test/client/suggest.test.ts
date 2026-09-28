import { describe, expect, it } from 'vitest';
import { suggest, type SuggestIn } from '../../src/game/features/activities/suggest';
import type { EventEntry } from '../../src/shared/sim/rules/types';
import type { MiniOpen } from '../../src/shared/sim/rules/minigames/types';
import { MINI_INFO } from '../../src/shared/sim/rules/minigames/catalog';

const base: SuggestIn = { me: { x: 0, y: 0 }, inCar: false, online: true, wanted: 0, busy: false, events: [], open: [], booths: [], sprayShops: [], turn: 0 };

describe('Čo teraz?', () => {
  it('on the run: only the nearest spray shop', () => {
    const s = suggest({ ...base, wanted: 2, sprayShops: [{ x: 900, y: 0 }, { x: 200, y: 0 }], events: [{ id: 1, kind: 'kofolka', phase: 'live', left: 60, x: 10, y: 0 } as EventEntry] });
    expect(s).toHaveLength(1);
    expect(s[0].act).toEqual({ op: 'gps', x: 200, y: 0 });
  });
  it('nothing while something is already going', () => {
    expect(suggest({ ...base, busy: true })).toEqual([]);
  });
  it('a world event on now comes first, then a round to join nearby', () => {
    const ev = { id: 1, kind: 'derby', phase: 'live', left: 60, x: 300, y: 400 } as EventEntry;
    const open: MiniOpen = { id: 9, kind: 'butter', x: 100, y: 0, phase: 'lobby', left: 20, n: 1, max: 6, nick: 'Jana' };
    const s = suggest({ ...base, events: [ev], open: [open] });
    expect(s[0].act).toEqual({ op: 'gps', x: 300, y: 400 });
    expect(s[0].why).toContain('500 m');
    expect(s[1].act).toEqual({ op: 'join', id: 9 });
    expect(s).toHaveLength(3);
  });
  it('offline: the nearest mission booth, then a mini-game that fits, then a shift', () => {
    const s = suggest({ ...base, online: false, booths: [{ x: 3000, y: 0, title: 'Taxi' }, { x: 50, y: 0, title: 'Kofolka' }] });
    expect(s[0].title).toBe('Misia: Kofolka');
    expect(s[1].act.op).toBe('mini');
    expect(s[2].act).toEqual({ op: 'job', kind: 'courier' });
  });
  it('on foot never offers a mini-game that needs a car; in a car a taxi shift', () => {
    for (let turn = 0; turn < 12; turn++) {
      const m = suggest({ ...base, turn }).find((x) => x.act.op === 'mini')!;
      expect(m.act.op === 'mini' && MINI_INFO[m.act.kind].needs.includes('auto')).toBe(false);
    }
    expect(suggest({ ...base, inCar: true }).at(-1)!.act).toEqual({ op: 'job', kind: 'taxi' });
  });
});
