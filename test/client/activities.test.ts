// What the Aktivity panel and its HUD chip say about world events (src/game/features/activities/):
// the forecast worked out from the director's plan, and its Slovak lines.
import { describe, expect, it } from 'vitest';
import { forecast, type KindStatus } from '../../src/game/features/activities/forecast';
import { candidatesLine, chipLine, clock, mins, morePlayersLine, nextLine, players, statusText } from '../../src/game/features/activities/text';
import type { EventKind, EventSchedule } from '../../src/shared/sim/rules/types';

/** the server's real line-up: what each kind needs (rules/events/*) */
function plan(over: Partial<EventSchedule> = {}, cd: Partial<Record<EventKind, number>> = {}): EventSchedule {
  return {
    on: true,
    next: 200,
    players: 1,
    offline: false,
    kinds: [
      { kind: 'kofolka', min: 2, cd: cd.kofolka ?? 0, sched: true },
      { kind: 'cumil', min: 1, cd: cd.cumil ?? 0, sched: true },
      { kind: 'wanted', min: 2, cd: 0, sched: false },
      { kind: 'derby', min: 3, cd: cd.derby ?? 0, sched: true },
      { kind: 'armored', min: 2, cd: cd.armored ?? 0, sched: true },
    ],
    ...over,
  };
}

const statusOf = (f: ReturnType<typeof forecast>, kind: EventKind): KindStatus => f.kinds.find((k) => k.kind === kind)!.status;

describe('world-event forecast', () => {
  it('alone online: only the Čumil hunt can come, when the timer runs out', () => {
    const f = forecast(plan(), 0, []);
    expect(f.next).toBe(200);
    expect(f.busy).toBe(false);
    expect(f.candidates).toEqual(['cumil']);
    expect(statusOf(f, 'cumil')).toEqual({ s: 'ready' });
    expect(statusOf(f, 'kofolka')).toEqual({ s: 'players', need: 2, have: 1 });
    expect(statusOf(f, 'armored')).toEqual({ s: 'players', need: 2, have: 1 });
    expect(statusOf(f, 'derby')).toEqual({ s: 'players', need: 3, have: 1 });
    expect(statusOf(f, 'wanted')).toEqual({ s: 'trigger', need: 2, have: 1 });
  });

  it('two players: the Kofolka van and the armoured van join in; the derby still needs a third', () => {
    const f = forecast(plan({ players: 2 }), 0, []);
    expect(f.candidates.sort()).toEqual(['armored', 'cumil', 'kofolka']);
    expect(statusOf(f, 'derby')).toEqual({ s: 'players', need: 3, have: 2 });
  });

  it('a cooldown longer than the timer decides when the next one can come', () => {
    const f = forecast(plan({ next: 30 }, { cumil: 600 }), 0, []);
    expect(f.next).toBe(600);
    expect(f.candidates).toEqual(['cumil']);
    expect(statusOf(f, 'cumil')).toEqual({ s: 'cooldown', secs: 600 });
  });

  it('counts down from when the plan arrived', () => {
    const f = forecast(plan({ players: 2, next: 200 }, { cumil: 600 }), 100, []);
    expect(f.next).toBe(100);
    expect(f.candidates.sort()).toEqual(['armored', 'kofolka']); // the Čumil hunt is 500 s off yet
    expect(statusOf(f, 'cumil')).toEqual({ s: 'cooldown', secs: 500 });
  });

  it('a scheduled event on holds the next one back; the most wanted chase does not', () => {
    const on = forecast(plan({ players: 2 }), 0, ['kofolka']);
    expect(on.busy).toBe(true);
    expect(statusOf(on, 'kofolka')).toEqual({ s: 'live' });
    expect(on.candidates).not.toContain('kofolka');
    const chase = forecast(plan({ players: 2 }), 0, ['wanted']);
    expect(chase.busy).toBe(false);
    expect(statusOf(chase, 'wanted')).toEqual({ s: 'live' });
  });

  it('counts a player who is away (in the pause menu) back in', () => {
    const f = forecast(plan({ players: 1 }), 0, [], true);
    expect(f.players).toBe(2);
    expect(statusOf(f, 'kofolka')).toEqual({ s: 'ready' });
  });

  it('offline: the online-only kinds never come, and player counts hold nothing back', () => {
    const s = plan({ offline: true });
    for (const k of s.kinds) if (['kofolka', 'derby', 'wanted'].includes(k.kind)) k.never = true;
    const f = forecast(s, 0, []);
    expect(statusOf(f, 'kofolka')).toEqual({ s: 'never' });
    expect(statusOf(f, 'wanted')).toEqual({ s: 'never' });
    expect(statusOf(f, 'armored')).toEqual({ s: 'ready' });
    expect(f.candidates.sort()).toEqual(['armored', 'cumil']);
  });

  it('switched off: nothing on the schedule comes, but the most wanted still can', () => {
    const f = forecast(plan({ on: false, players: 3 }), 0, []);
    expect(f.next).toBeNull();
    expect(statusOf(f, 'cumil')).toEqual({ s: 'off' });
    expect(statusOf(f, 'wanted')).toEqual({ s: 'trigger', need: 2, have: 3 });
  });
});

describe('Aktivity wording', () => {
  it('says when the next event comes, or why none can', () => {
    expect(nextLine(forecast(plan(), 0, []))).toBe('Ďalšia udalosť asi o 4 min.');
    expect(nextLine(forecast(plan({ next: 20 }), 0, []))).toBe('Ďalšia udalosť o chvíľu.');
    expect(nextLine(forecast(plan({ players: 2 }), 0, ['kofolka']))).toBe('Ďalšia udalosť príde, až keď skončí táto.');
    expect(nextLine(forecast(plan({ on: false }), 0, []))).toBe('Udalosti sú teraz vypnuté.');
    const noCumil = plan();
    noCumil.kinds = noCumil.kinds.filter((k) => k.kind !== 'cumil');
    expect(nextLine(forecast(noCumil, 0, []))).toBe('Na ďalšie udalosti treba viac hráčov.');
  });

  it('names what the next one could be', () => {
    expect(candidatesLine(forecast(plan(), 0, []))).toBe('Na rade je Hon na Čumila.');
    expect(candidatesLine(forecast(plan({ players: 2 }), 0, []))).toBe('Môže to byť Horúca Kofolka, Hon na Čumila alebo Obrnené auto.');
    expect(candidatesLine(forecast(plan({ players: 2 }), 0, ['cumil']))).toBe('');
  });

  it('nudges a lone player toward a friend, in the panel order', () => {
    expect(morePlayersLine(forecast(plan(), 0, []))).toBe('Horúca Kofolka, Obrnené auto a Derby na parkovisku prídu, keď vás bude v meste viac – pozvi kamaráta do partie.');
    expect(morePlayersLine(forecast(plan({ players: 2 }), 0, []))).toBe('Derby na parkovisku príde, keď vás bude v meste viac – pozvi kamaráta do partie.');
    expect(morePlayersLine(forecast(plan({ players: 3 }), 0, []))).toBe('');
  });

  it('puts each status in a few words', () => {
    expect(statusText({ s: 'ready' })).toEqual({ text: 'môže prísť na rad', tone: 'ready' });
    expect(statusText({ s: 'cooldown', secs: 721 })).toEqual({ text: 'znova o 13 min', tone: 'wait' });
    expect(statusText({ s: 'cooldown', secs: 30 }).text).toBe('znova o chvíľu');
    expect(statusText({ s: 'players', need: 3, have: 1 }).text).toBe('treba aspoň 3 hráčov · teraz 1');
    expect(statusText({ s: 'trigger', need: 2, have: 1 }).text).toBe('pri 5★ · treba aspoň 2 hráčov');
    expect(statusText({ s: 'trigger', need: 2, have: 4 }).text).toBe('keď niekto dosiahne 5★');
    expect(statusText({ s: 'never' }).text).toBe('iba online');
  });

  it('the HUD chip: when the next one comes, or that one is on', () => {
    expect(chipLine(null)).toBe('');
    expect(chipLine(forecast(plan(), 0, []))).toBe('udalosť o 4 min');
    expect(chipLine(forecast(plan({ next: 5 }), 0, []))).toBe('udalosť o chvíľu');
    expect(chipLine(forecast(plan({ players: 2 }), 0, ['armored']))).toBe('udalosť práve beží');
    expect(chipLine(forecast(plan({ on: false }), 0, []))).toBe('');
  });

  it('numbers', () => {
    expect([mins(1), mins(60), mins(61), mins(600)]).toEqual(['1 min', '1 min', '2 min', '10 min']);
    expect([clock(0), clock(42.2), clock(725)]).toEqual(['0:00', '0:43', '12:05']);
    expect([players(1), players(3), players(5)]).toEqual(['1 hráč', '3 hráči', '5 hráčov']);
  });
});
