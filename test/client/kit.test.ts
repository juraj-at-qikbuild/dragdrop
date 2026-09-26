// Pure-logic tests for the client UI kit (src/ui/kit/): the Banners queue's ordering, pre-emption and
// timing, and the settings() helper against a fake localStorage. The environment is node (see
// vitest.config.ts), so nothing here touches the DOM or canvas.
import { beforeEach, describe, expect, it } from 'vitest';
import { Banners } from '../../src/ui/kit/Banners';
import { setting } from '../../src/ui/kit/settings';

/** advances a Banners queue by `secs`, in small steps (matching how Game.update ticks it per frame) */
function tick(b: Banners, secs: number, step = 0.02) {
  for (let t = 0; t < secs; t += step) b.update(step);
}

describe('Banners', () => {
  it('starts idle, then shows a pushed banner right away', () => {
    const b = new Banners();
    expect(b.current).toBeNull();
    expect(b.pending).toBe(0);
    b.push({ title: 'HORÚCA KOFOLKA' });
    expect(b.current?.title).toBe('HORÚCA KOFOLKA');
    expect(b.pending).toBe(0);
  });

  it('fills in defaults for text, colour, time and priority', () => {
    const b = new Banners();
    b.push({ title: 'A' });
    expect(b.current).toMatchObject({ title: 'A', text: '', priority: 0 });
    expect(b.current!.time).toBeGreaterThan(0);
    expect(b.current!.color).toBeTruthy();
  });

  it('queues further banners of the same priority in push order (FIFO)', () => {
    const b = new Banners();
    b.push({ title: 'A', time: 0.5 });
    b.push({ title: 'B', time: 0.5 });
    b.push({ title: 'C', time: 0.5 });
    expect(b.current?.title).toBe('A');
    expect(b.pending).toBe(2);
    tick(b, 1.3); // just past A's in-slide + 0.5s hold + out-slide (~1.2s total)
    expect(b.current?.title).toBe('B');
    expect(b.pending).toBe(1);
    tick(b, 1.3);
    expect(b.current?.title).toBe('C');
    expect(b.pending).toBe(0);
    tick(b, 1.3);
    expect(b.current).toBeNull();
  });

  it('does not let an equal priority pre-empt what is already showing', () => {
    const b = new Banners();
    b.push({ title: 'A', priority: 3, time: 5 });
    b.push({ title: 'B', priority: 3 });
    expect(b.current?.title).toBe('A');
    expect(b.pending).toBe(1);
  });

  it('a strictly higher priority pre-empts immediately; the pre-empted banner resumes later, from the start', () => {
    const b = new Banners();
    b.push({ title: 'A', priority: 0, time: 5 });
    b.push({ title: 'B', priority: 0, time: 5 }); // queued behind A
    tick(b, 1); // A is mid-hold
    b.push({ title: 'C', priority: 5, time: 0.5 }); // pre-empts A right away
    expect(b.current?.title).toBe('C');
    expect(b.pending).toBe(2); // [A, B]: A resumes before B
    tick(b, 3); // C plays out fully
    expect(b.current?.title).toBe('A');
    expect(b.current!.time).toBe(5); // resumed from the start, not from where it was cut off
    expect(b.pending).toBe(1);
  });

  it('a second pre-emption re-queues the first one in front of the earlier queue', () => {
    const b = new Banners();
    b.push({ title: 'A', time: 5 });
    b.push({ title: 'B', priority: 1, time: 5 });
    b.push({ title: 'C', priority: 2, time: 0.5 });
    expect(b.current?.title).toBe('C');
    tick(b, 3);
    expect(b.current?.title).toBe('B'); // most recently pre-empted resumes first
    tick(b, 6);
    expect(b.current?.title).toBe('A');
  });

  it('goes idle once the queue drains', () => {
    const b = new Banners();
    b.push({ title: 'A', time: 0.3 });
    tick(b, 2);
    expect(b.current).toBeNull();
    expect(b.pending).toBe(0);
  });
});

/** the minimal bit of `Storage` settings.ts actually calls */
class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('setting()', () => {
  let store: FakeStorage;

  beforeEach(() => {
    store = new FakeStorage();
    (globalThis as unknown as { localStorage: FakeStorage }).localStorage = store;
  });

  it('falls back when nothing is stored yet, under a blava-city- prefixed key', () => {
    const s = setting('foo', 'bar');
    expect(s.get()).toBe('bar');
    expect(store.getItem('blava-city-foo')).toBeNull();
  });

  it('round-trips a value through the fake store, JSON-encoded', () => {
    const s = setting('vol', 0.5);
    s.set(0.8);
    expect(store.getItem('blava-city-vol')).toBe('0.8');
    expect(setting('vol', 0.5).get()).toBe(0.8);
  });

  it('round-trips an object', () => {
    setting<{ on: boolean }>('x', { on: false }).set({ on: true });
    expect(setting<{ on: boolean }>('x', { on: false }).get()).toEqual({ on: true });
  });

  it('falls back when the stored value fails validate()', () => {
    type Mode = 'off' | 'push' | 'open';
    const isMode = (v: unknown): v is Mode => v === 'off' || v === 'push' || v === 'open';
    store.setItem('blava-city-voice-mode', JSON.stringify('bogus'));
    expect(setting<Mode>('voice-mode', 'off', isMode).get()).toBe('off');
    store.setItem('blava-city-voice-mode', JSON.stringify('push'));
    expect(setting<Mode>('voice-mode', 'off', isMode).get()).toBe('push');
  });

  it('falls back when the stored JSON is corrupt, without throwing', () => {
    store.setItem('blava-city-y', '{not json');
    const s = setting('y', 'fallback');
    expect(() => s.get()).not.toThrow();
    expect(s.get()).toBe('fallback');
  });

  it('is try/catch safe with no localStorage at all (get and set)', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const s = setting('z', 42);
    expect(s.get()).toBe(42);
    expect(() => s.set(7)).not.toThrow();
  });
});
