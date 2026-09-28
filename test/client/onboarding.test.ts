// The introduction a newcomer gets on their first start (src/game/features/onboarding/): who counts as
// new, when it opens by itself, and what its cards say for each way of playing, online and off.
import { describe, expect, it } from 'vitest';
import { forecast } from '../../src/game/features/activities/forecast';
import {
  aktivityHint, autoIntro, basics, comingLine, eventKinds, eventTip, introParam, looksNew, onNowLine, onlineOnlyLine, things, type InputKind, type Parts,
} from '../../src/game/features/onboarding/text';
import type { EventEntry, EventKind, EventSchedule } from '../../src/shared/sim/rules/types';
import type { Profile } from '../../src/shared/sim/SimPlayer';

/** the director's plan as the server (or, `offline`, the single-player rules) sends it */
function plan(over: Partial<EventSchedule> = {}): EventSchedule {
  const offline = over.offline ?? false;
  const kinds: EventSchedule['kinds'] = [
    { kind: 'kofolka', min: 2, cd: 0, sched: true },
    { kind: 'cumil', min: 1, cd: 0, sched: true },
    { kind: 'wanted', min: 2, cd: 0, sched: false },
    { kind: 'derby', min: 3, cd: 0, sched: true },
    { kind: 'armored', min: 2, cd: 0, sched: true },
  ];
  if (offline) for (const k of kinds) if (k.kind === 'kofolka' || k.kind === 'derby' || k.kind === 'wanted') k.never = true;
  return { on: true, next: 200, players: 1, offline, kinds, ...over };
}

const profile = (over: Partial<Profile> = {}): Profile => ({ money: 0, done: [], found: [], cumils: [], ...over });
const say = (parts: Parts) => parts.map((p) => (typeof p === 'string' ? p : `[${p.key}]`)).join('');
const INPUTS: InputKind[] = ['key', 'pad', 'touch'];

describe('who gets the introduction', () => {
  it('a player with nothing to show yet', () => {
    expect(looksNew(profile())).toBe(true);
    expect(looksNew(profile({ gear: {} }))).toBe(true);
    expect(looksNew(profile({ money: 40 }))).toBe(false);
    expect(looksNew(profile({ done: ['taxi'] }))).toBe(false);
    expect(looksNew(profile({ found: ['castle'] }))).toBe(false);
    expect(looksNew(profile({ cumils: [3] }))).toBe(false);
    // spent everything on the collection, or a jacket: still not new
    expect(looksNew(profile({ gear: { seen: ['sedan'] } }))).toBe(false);
    expect(looksNew(profile({ gear: { look: 2 } }))).toBe(false);
  });

  it('opens by itself once per device, and never in an automated browser', () => {
    const base = { param: null, automated: false, seen: false, fresh: true };
    expect(autoIntro(base)).toBe(true);
    expect(autoIntro({ ...base, seen: true })).toBe(false);
    expect(autoIntro({ ...base, fresh: false })).toBe(false);
    expect(autoIntro({ ...base, automated: true })).toBe(false);
  });

  it('?intro=1 and ?intro=0 decide instead', () => {
    expect(introParam('?t=12&intro=1')).toBe('on');
    expect(introParam('?intro=0')).toBe('off');
    expect(introParam('?intro=yes')).toBeNull();
    expect(introParam('')).toBeNull();
    const all = { automated: true, seen: true, fresh: false };
    expect(autoIntro({ ...all, param: 'on' })).toBe(true);
    expect(autoIntro({ param: 'off', automated: false, seen: false, fresh: true })).toBe(false);
  });
});

describe('the basics', () => {
  it('four controls for each way of playing', () => {
    for (const input of INPUTS) expect(basics(input)).toHaveLength(4);
    expect(basics('key').map((r) => r.cap)).toEqual(['WASD', 'F', 'Myš', 'M']);
    // the pad's buttons as the HUD's legend names them
    expect(basics('pad').map((r) => r.cap)).toEqual(['LS', 'Y', 'RT', '⧉']);
    expect(basics('touch').some((r) => r.text.includes('minimapu'))).toBe(true);
    expect(basics('touch').some((r) => r.text.includes('žlté tlačidlo'))).toBe(true);
  });
});

describe('the world events card', () => {
  it('online: every kind', () => {
    const f = forecast(plan(), 0, []);
    expect(eventKinds(f)).toEqual({ here: ['kofolka', 'cumil', 'armored', 'derby', 'wanted'], onlineOnly: [] });
    expect(eventKinds(null).here).toHaveLength(5);
  });

  it('offline: the two that run alone, and what online play adds', () => {
    const f = forecast(plan({ offline: true }), 0, []);
    const k = eventKinds(f);
    expect(k.here).toEqual(['cumil', 'armored']);
    expect(k.onlineOnly).toEqual(['kofolka', 'derby', 'wanted']);
    expect(onlineOnlyLine(k.onlineOnly)).toBe('Online pribudnú aj Horúca Kofolka, Derby na parkovisku a Najhľadanejší.');
    expect(onlineOnlyLine(['derby'])).toBe('Online pribudne aj Derby na parkovisku.');
    expect(onlineOnlyLine([])).toBe('');
  });

  it('a kind the plan leaves out is left out', () => {
    const s = plan();
    s.kinds = s.kinds.filter((k) => k.kind !== 'derby');
    expect(eventKinds(forecast(s, 0, [])).here).not.toContain('derby');
  });

  it('what is on now, and where', () => {
    const e = (kind: EventKind, phase: EventEntry['phase'], place?: string): EventEntry => ({ id: 1, kind, phase, left: 30, place });
    expect(onNowLine(e('kofolka', 'live', 'pri Eurovei'), 90)).toBe('🥤 Horúca Kofolka práve beží pri Eurovei');
    // (roughly: the card doesn't count down)
    expect(onNowLine(e('cumil', 'announce'), 42)).toBe('🔍 Hon na Čumila začne o chvíľu');
    expect(onNowLine(e('derby', 'announce', 'pri Auparku'), 150)).toBe('🎡 Derby na parkovisku začne asi o 3 min pri Auparku');
  });

  it('with nothing on: when the next may come, and what it could be', () => {
    expect(comingLine(forecast(plan(), 0, []))).toBe('Ďalšia udalosť asi o 4 min. Na rade je Hon na Čumila.');
    expect(comingLine(forecast(plan({ on: false }), 0, []))).toBe('Udalosti sú teraz vypnuté.');
  });
});

describe('everything else to do', () => {
  it('online: jobs, races, the party, the daily photo and the shops, and the leaderboard where kept', () => {
    const titles = (board: boolean) => things({ online: true, input: 'key', board }).map((t) => t.title);
    expect(titles(true)).toEqual(['Práca', 'Závod?', 'Partia', 'Kde to je?', 'Obchody', 'Rebríček']);
    expect(titles(false)).not.toContain('Rebríček');
  });

  it('offline: missions, jobs, the shops and the collectibles; nothing online-only', () => {
    const titles = things({ online: false, input: 'key', board: true }).map((t) => t.title);
    expect(titles).toEqual(['Misie', 'Práca', 'Obchody', 'Objavuj']);
  });

  it('keys as the player plays: keyboard keys, the pad buttons it has, none on touch', () => {
    const keys = (input: InputKind) => Object.fromEntries(things({ online: true, input, board: true }).map((t) => [t.title, t.key]));
    expect(keys('key')).toMatchObject({ Práca: 'J', 'Závod?': 'H', Partia: 'N', 'Kde to je?': 'K', Rebríček: 'L', Obchody: null });
    expect(keys('pad')).toMatchObject({ Práca: '←', 'Závod?': 'X', Partia: null, Rebríček: null });
    expect(Object.values(keys('touch')).every((k) => k === null)).toBe(true);
  });

  it('points at the Aktivity panel the way the player opens it', () => {
    expect(say(aktivityHint('key'))).toBe('Všetko toto nájdeš v Aktivitách – stlač [U].');
    expect(say(aktivityHint('pad'))).toBe('Všetko toto nájdeš v Aktivitách – stlač [↓] na krížiku.');
    expect(say(aktivityHint('touch'))).toBe('Všetko toto nájdeš v Aktivitách – ťukni na ☰ Aktivity.');
  });
});

describe('the first world event tip', () => {
  it('names the way to the Aktivity panel', () => {
    expect(eventTip('key')).toBe('💡 V meste je udalosť! Stlač U – zistíš, o čo ide, a nastavíš si k nej navigáciu.');
    expect(eventTip('pad')).toContain('Stlač ↓ na krížiku');
    expect(eventTip('touch')).toContain('Ťukni na ☰ Aktivity');
  });
});
