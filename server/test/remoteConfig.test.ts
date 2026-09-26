import { describe, expect, it, vi } from 'vitest';
import { Room } from '../src/Room';
import { RemoteConfig } from '../src/features/RemoteConfig';
import { Supa } from '../src/supa';
import { disabledSupa, loadWorld } from './helpers';

/** a Room with no other features doing network I/O; each test builds its own RemoteConfig so it
 *  controls exactly what game_config the fake Supa answers with */
const testRoom = () => new Room({ world: loadWorld(), seed: 1, debug: true, supa: disabledSupa() });

/** a Supa whose fetch answers `select=key,value` with `rows` every time (until reprogrammed) */
function fakeSupa(rows: { key: string; value: unknown }[]) {
  const fn = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
  const supa = new Supa('https://x.example', 'k', { fetch: fn as unknown as typeof fetch });
  return { supa, fn };
}

/** RemoteConfig has no public "reload now"; tests that need a second load reach past the (compile-time
 *  only) `private` to call it directly, the same load() the boot and the 60s interval both use */
const reload = (rc: RemoteConfig) => (rc as unknown as { load(): Promise<void> }).load();

/** let RemoteConfig's fire-and-forget load() (an async function awaiting the fake fetch's resolved
 *  Promise) settle before asserting */
const flushLoad = () => new Promise((r) => setTimeout(r, 0));

describe('RemoteConfig', () => {
  it('uses hardcoded defaults when Supabase is disabled', async () => {
    const rc = new RemoteConfig(testRoom(), disabledSupa());
    await flushLoad();
    expect(rc.get('voice_enabled')).toBe(true);
    expect(rc.get('voice_requires_account')).toBe(true);
    expect(rc.get('voice_blocklist')).toEqual([]);
    expect(rc.get('events')).toEqual({});
  });

  it('applies fetched values of the right type, and notifies onChange', async () => {
    const { supa } = fakeSupa([
      { key: 'voice_enabled', value: false },
      { key: 'voice_blocklist', value: ['acct:banned-1'] },
      { key: 'events', value: { enabled: false } },
    ]);
    const rc = new RemoteConfig(testRoom(), supa);
    const seen: unknown[] = [];
    rc.onChange((v) => seen.push(v));
    await flushLoad();
    expect(rc.get('voice_enabled')).toBe(false);
    expect(rc.get('voice_blocklist')).toEqual(['acct:banned-1']);
    expect(rc.get('voice_requires_account')).toBe(true); // untouched key keeps its default
    expect(seen).toHaveLength(1);
  });

  it('rejects values of the wrong type and keeps the default for that key', async () => {
    const { supa } = fakeSupa([
      { key: 'voice_enabled', value: 'yes' }, // wrong type: string, not boolean
      { key: 'voice_blocklist', value: 'not-an-array' },
      { key: 'voice_requires_account', value: 1 },
      { key: 'events', value: 'nope' },
    ]);
    const rc = new RemoteConfig(testRoom(), supa);
    await flushLoad();
    expect(rc.get('voice_enabled')).toBe(true);
    expect(rc.get('voice_blocklist')).toEqual([]);
    expect(rc.get('voice_requires_account')).toBe(true);
    expect(rc.get('events')).toEqual({});
  });

  it('unsubscribe stops further onChange notifications', async () => {
    const { supa } = fakeSupa([{ key: 'voice_enabled', value: false }]);
    const rc = new RemoteConfig(testRoom(), supa);
    const seen: unknown[] = [];
    const off = rc.onChange((v) => seen.push(v));
    await flushLoad();
    off();
    await reload(rc);
    expect(seen).toHaveLength(1);
  });

  it('keeps the last known values when a reload fails, and logs the failure', async () => {
    const { supa, fn } = fakeSupa([]);
    const rc = new RemoteConfig(testRoom(), supa);
    await flushLoad();
    fn.mockImplementation(async () => {
      throw new Error('network down');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reload(rc);
    expect(rc.get('voice_enabled')).toBe(true); // unchanged
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('applies known events fields to the director, validating each one', async () => {
    const room = testRoom();
    const { supa } = fakeSupa([{ key: 'events', value: { gap: [100, 200], retry: 15, enabled: false, bogus: 'x', offlineGap: 'nope' } }]);
    new RemoteConfig(room, supa);
    await flushLoad();
    const cfg = room.director!.config;
    expect(cfg.gap).toEqual([100, 200]);
    expect(cfg.retry).toBe(15);
    expect(cfg.enabled).toBe(false);
    expect(cfg.offlineGap).toEqual([12 * 60, 18 * 60]); // malformed: left at its default
  });

  it('E2E override forces voice_requires_account to false regardless of game_config, until cleared', async () => {
    const { supa } = fakeSupa([{ key: 'voice_requires_account', value: true }]);
    const rc = new RemoteConfig(testRoom(), supa, { e2e: true });
    await flushLoad();
    expect(rc.get('voice_requires_account')).toBe(false);
    rc.setVoiceRequiresAccountOverride(null);
    expect(rc.get('voice_requires_account')).toBe(true); // back to whatever game_config said
  });

  it('shutdown() stops the 60s refresh interval', async () => {
    vi.useFakeTimers();
    try {
      const { supa, fn } = fakeSupa([]);
      const rc = new RemoteConfig(testRoom(), supa);
      await vi.advanceTimersByTimeAsync(0); // let the boot load() land
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fn).toHaveBeenCalledTimes(2); // the interval fired once
      rc.shutdown();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fn).toHaveBeenCalledTimes(2); // no further reloads after shutdown
    } finally {
      vi.useRealTimers();
    }
  });
});
