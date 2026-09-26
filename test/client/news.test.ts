// Pure-logic tests for Rádio Kecy's breaking news: the formatter (news/lines.ts) and the queue
// (news/NewsQueue.ts). Neither touches the DOM, Canvas or Game — see the module docs for why (the
// environment is node, see vitest.config.ts).
import { describe, expect, it } from 'vitest';
import { formatNews } from '../../src/game/features/news/lines';
import { NewsQueue } from '../../src/game/features/news/NewsQueue';
import type { GlobalEvent } from '../../src/shared/sim/events';
import type { EventKind } from '../../src/shared/sim/rules/types';

const place = (x: number, y: number) => `pri bode ${x},${y}`;
const KINDS: EventKind[] = ['kofolka', 'wanted', 'cumil', 'armored', 'derby'];
const END_HOWS = ['won', 'expired', 'wrecked', 'robbed', 'delivered', 'cancelled'] as const;
const MOST_WANTED_HOWS = ['taken', 'busted', 'escaped', 'died', 'left'] as const;

/** every line must be non-empty Slovak text with no leftover template artefacts */
function assertClean(text: string) {
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(/undefined/i);
  expect(text).not.toMatch(/NaN/);
  expect(text).not.toMatch(/\$\{/);
}

describe('formatNews', () => {
  it('eventAnnounce: every EventKind yields a clean line with the place filled in, priority 2', () => {
    for (const kind of KINDS) {
      const line = formatNews({ k: 'eventAnnounce', kind, x: 10, y: 20, secs: 45 }, place);
      expect(line, kind).not.toBeNull();
      assertClean(line!.text);
      expect(line!.text).toContain(place(10, 20));
      expect(line!.priority).toBe(2);
    }
  });

  it('eventStart: every EventKind yields a clean line with the place filled in, priority 2', () => {
    for (const kind of KINDS) {
      const line = formatNews({ k: 'eventStart', kind, x: 1, y: 2 }, place);
      expect(line, kind).not.toBeNull();
      assertClean(line!.text);
      expect(line!.text).toContain(place(1, 2));
      expect(line!.priority).toBe(2);
    }
  });

  it('eventEnd: every EventKind x how yields a clean line; "won" is priority 3, everything else 2', () => {
    for (const kind of KINDS) {
      for (const how of END_HOWS) {
        const line = formatNews({ k: 'eventEnd', kind, how, winner: 'Fero', amount: 500, x: 3, y: 4 }, place);
        expect(line, `${kind}/${how}`).not.toBeNull();
        assertClean(line!.text);
        expect(line!.priority).toBe(how === 'won' ? 3 : 2);
      }
    }
  });

  it('eventEnd: still clean with no winner/amount (a timeout or a cancellation never carries them)', () => {
    for (const how of ['expired', 'cancelled'] as const) {
      const line = formatNews({ k: 'eventEnd', kind: 'derby', how, x: 0, y: 0 }, place)!;
      assertClean(line.text);
    }
    // "won" with no amount/winner (defensive: the union allows it) must still read cleanly
    const won = formatNews({ k: 'eventEnd', kind: 'kofolka', how: 'won', x: 0, y: 0 }, place)!;
    assertClean(won.text);
  });

  it('holder: every EventKind names the current holder, priority 1', () => {
    for (const kind of KINDS) {
      const line = formatNews({ k: 'holder', kind, nick: 'Fero', x: 5, y: 6 }, place);
      expect(line, kind).not.toBeNull();
      assertClean(line!.text);
      expect(line!.text).toContain('Fero');
      expect(line!.priority).toBe(1);
    }
  });

  it('mostWanted names the player, the place and the bounty, priority 3', () => {
    const line = formatNews({ k: 'mostWanted', nick: 'Fero', x: 7, y: 8, bounty: 1234 }, place)!;
    assertClean(line.text);
    expect(line.text).toContain('Fero');
    expect(line.text).toContain(place(7, 8));
    expect(line.priority).toBe(3);
  });

  it('mostWantedEnd: every how yields a clean line; "taken" is priority 3, everything else 2', () => {
    for (const how of MOST_WANTED_HOWS) {
      const line = formatNews({ k: 'mostWantedEnd', nick: 'Fero', how, by: how === 'taken' ? 'Jožo' : undefined, amount: 900, x: 1, y: 1 }, place);
      expect(line, how).not.toBeNull();
      assertClean(line!.text);
      expect(line!.text).toContain('Fero');
      expect(line!.priority).toBe(how === 'taken' ? 3 : 2);
    }
  });

  it('raceStart names both players and the stake, priority 2', () => {
    const line = formatNews({ k: 'raceStart', a: 'Fero', b: 'Jožo', dest: 'Aupark', stake: 250 }, place)!;
    assertClean(line.text);
    expect(line.text).toContain('Fero');
    expect(line.text).toContain('Jožo');
    expect(line.priority).toBe(2);
  });

  it('raceResult names winner and loser, priority 3', () => {
    const line = formatNews({ k: 'raceResult', winner: 'Fero', loser: 'Jožo', dest: 'Aupark', amount: 500 }, place)!;
    assertClean(line.text);
    expect(line.text).toContain('Fero');
    expect(line.text).toContain('Jožo');
    expect(line.priority).toBe(3);
  });

  it('derbyResult names the winners, priority 3, and stays clean with no winners at all', () => {
    const line = formatNews({ k: 'derbyResult', winners: ['Fero', 'Jožo'], place: 'pri Auparku' }, place)!;
    assertClean(line.text);
    expect(line.text).toContain('Fero');
    expect(line.priority).toBe(3);
    const empty = formatNews({ k: 'derbyResult', winners: [], place: 'pri Auparku' }, place)!;
    assertClean(empty.text);
  });

  it('daily-puzzle events: reveal(2), hint(1) with its text, solved(3), answer(2)', () => {
    const reveal = formatNews({ k: 'dailyReveal', img: 'https://x/y.webp' }, place)!;
    assertClean(reveal.text);
    expect(reveal.priority).toBe(2);

    const hint = formatNews({ k: 'dailyHint', level: 1, text: 'Je to v Petržalke.' }, place)!;
    assertClean(hint.text);
    expect(hint.text).toContain('Je to v Petržalke.');
    expect(hint.priority).toBe(1);

    const solved = formatNews({ k: 'dailySolved', nick: 'Fero' }, place)!;
    assertClean(solved.text);
    expect(solved.text).toContain('Fero');
    expect(solved.priority).toBe(3);

    const answer = formatNews({ k: 'dailyAnswer', x: 1, y: 2 }, place)!;
    assertClean(answer.text);
    expect(answer.text).toContain(place(1, 2));
    expect(answer.priority).toBe(2);
  });

  it('revived names both players and the place, priority 1', () => {
    const line = formatNews({ k: 'revived', by: 'Fero', who: 'Jožo', x: 1, y: 2 }, place)!;
    assertClean(line.text);
    expect(line.text).toContain('Fero');
    expect(line.text).toContain('Jožo');
    expect(line.priority).toBe(1);
  });

  it('is deterministic: the same event contents always pick the same variant', () => {
    const e: GlobalEvent = { k: 'mostWanted', nick: 'Fero', x: 7, y: 8, bounty: 1234 };
    expect(formatNews(e, place)!.text).toBe(formatNews({ ...e }, place)!.text);
  });

  it('varies with the event contents (not stuck on a single variant)', () => {
    const texts = new Set<string>();
    for (let i = 0; i < 25; i++) texts.add(formatNews({ k: 'mostWanted', nick: `Hráč${i}`, x: i, y: i, bounty: 300 + i * 17 }, place)!.text);
    expect(texts.size).toBeGreaterThan(1);
  });
});

describe('NewsQueue', () => {
  it('shows the first pushed line right away', () => {
    const q = new NewsQueue();
    q.push({ text: 'A', priority: 1 }, 0);
    expect(q.next(0)).toBe('A');
  });

  it('returns null with nothing queued', () => {
    expect(new NewsQueue().next(0)).toBeNull();
  });

  it('allows at most one line every 20 s', () => {
    const q = new NewsQueue();
    q.push({ text: 'A', priority: 1 }, 0);
    q.push({ text: 'B', priority: 1 }, 0);
    expect(q.next(0)).toBe('A');
    expect(q.next(5_000)).toBeNull();
    expect(q.next(19_999)).toBeNull();
    expect(q.next(20_000)).toBe('B');
  });

  it('a higher-priority line jumps ahead of ones already queued', () => {
    const q = new NewsQueue();
    q.push({ text: 'low', priority: 1 }, 0);
    q.push({ text: 'high', priority: 3 }, 1_000); // arrives later, but matters more
    expect(q.next(20_000)).toBe('high');
    expect(q.next(40_000)).toBe('low');
  });

  it('same-priority items keep arrival order (oldest first)', () => {
    const q = new NewsQueue();
    q.push({ text: 'first', priority: 2 }, 0);
    q.push({ text: 'second', priority: 2 }, 1_000);
    expect(q.next(20_000)).toBe('first');
    expect(q.next(40_000)).toBe('second');
  });

  it('drops a line older than 60 s before it is ever shown', () => {
    const q = new NewsQueue();
    q.push({ text: 'stale', priority: 3 }, 0);
    expect(q.next(60_001)).toBeNull();
    expect(q.next(80_001)).toBeNull(); // really gone, not just delayed
  });

  it('keeps at most 5 items queued, evicting the lowest-priority one to make room', () => {
    const q = new NewsQueue();
    for (let i = 0; i < 5; i++) q.push({ text: `low${i}`, priority: 1 }, i);
    expect(q.size).toBe(5);
    q.push({ text: 'important', priority: 3 }, 5); // a 6th push must evict a priority-1 line, not this
    expect(q.size).toBe(5);
    q.push({ text: 'also-low', priority: 1 }, 6);
    expect(q.size).toBe(5);
    expect(q.next(20_000)).toBe('important'); // it survived the cap and comes out first
  });

  it('skips a repeat of the same text within 5 minutes, but allows it again after', () => {
    const q = new NewsQueue();
    q.push({ text: 'same', priority: 1 }, 0);
    q.push({ text: 'same', priority: 1 }, 1_000); // duplicate inside the window: dropped silently
    expect(q.next(20_000)).toBe('same');
    expect(q.next(40_000)).toBeNull(); // no second copy was ever queued
    q.push({ text: 'same', priority: 1 }, 5 * 60_000 + 1); // now outside the 5-minute window
    expect(q.next(5 * 60_000 + 20_000 + 1)).toBe('same');
  });
});
