// What the main menu's "Pokračovať online" says (src/net/lastSession.ts): where and when this device
// was last online, for as long as the server keeps that spot. The environment is node (see
// vitest.config.ts), so localStorage is a small in-memory stand-in here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agoText, continueNote, loadLastPlayed, noteOffline, noteOnline } from '../../src/net/lastSession';
import { RESUME_MS } from '../../src/shared/net/protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('agoText', () => {
  it('reads naturally in Slovak at every scale', () => {
    expect(agoText(0)).toBe('pred chvíľou');
    expect(agoText(59_000)).toBe('pred chvíľou');
    expect(agoText(12 * MIN)).toBe('pred 12 min');
    expect(agoText(3 * HOUR + 5 * MIN)).toBe('pred 3 h');
    expect(agoText(25 * HOUR)).toBe('pred 1 dňom');
    expect(agoText(50 * HOUR)).toBe('pred 2 dňami');
    expect(agoText(-5000)).toBe('pred chvíľou'); // a clock that went backwards
  });
});

describe('continueNote', () => {
  const now = 10 * RESUME_MS;
  it('says where and when while the spot is kept, and nothing once it is not', () => {
    expect(continueNote({ mode: 'online', online: { at: now - 12 * MIN, place: 'Obchodná' } }, now)).toBe('Obchodná · pred 12 min');
    expect(continueNote({ mode: 'offline', online: { at: now - 2 * HOUR, place: '' } }, now)).toBe('pred 2 h');
    expect(continueNote({ mode: 'online', online: { at: now - RESUME_MS, place: 'Obchodná' } }, now)).toBe('');
    expect(continueNote({ mode: 'offline', online: null }, now)).toBe('');
    expect(continueNote(null, now)).toBe('');
  });
});

describe('the last-played memory', () => {
  const g = globalThis as { localStorage?: unknown };
  beforeEach(() => {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  });
  afterEach(() => {
    delete g.localStorage;
  });

  it('remembers the last online spot across a single-player game in between', () => {
    expect(loadLastPlayed()).toBeNull();
    noteOnline('Obchodná', 1000);
    expect(loadLastPlayed()).toEqual({ mode: 'online', online: { at: 1000, place: 'Obchodná' } });
    noteOffline();
    expect(loadLastPlayed()).toEqual({ mode: 'offline', online: { at: 1000, place: 'Obchodná' } });
  });

  it('shrugs off storage it cannot read or that holds junk', () => {
    (g.localStorage as { setItem(k: string, v: string): void }).setItem('blava-city-last-played', '{nope');
    expect(loadLastPlayed()).toBeNull();
    (g.localStorage as { setItem(k: string, v: string): void }).setItem('blava-city-last-played', JSON.stringify({ mode: 'sideways' }));
    expect(loadLastPlayed()).toBeNull();
    delete g.localStorage; // unavailable altogether (a locked-down browser): no throw, just nothing
    expect(loadLastPlayed()).toBeNull();
    expect(() => noteOnline('x')).not.toThrow();
  });
});
