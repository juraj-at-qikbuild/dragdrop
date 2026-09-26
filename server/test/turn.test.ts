// turn.ts: parses Cloudflare's response, falls back to STUN on any failure, caches per session, and
// never logs anything secret. A fake fetch stands in for the network throughout.
import { describe, expect, it, vi } from 'vitest';
import { mintIceServers, STUN_SERVERS, withoutPort53, type TurnCacheEntry } from '../src/turn';

const CF_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys/kid-1/credentials/generate-ice-servers';

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('mintIceServers', () => {
  it('parses the Cloudflare response and posts the right request', async () => {
    const cfIce = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'], username: 'u1', credential: 'c1' }];
    const fn = fakeFetch(() => new Response(JSON.stringify({ iceServers: cfIce }), { status: 201 }));
    const cache = new Map<string, TurnCacheEntry>();
    const out = await mintIceServers('kid-1', 'tok-1', fn, cache, 'sess-a');
    expect(out).toEqual(cfIce);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CF_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 86400 });
  });

  it('falls back to STUN-only when no key/token is configured, without ever calling fetch', async () => {
    const fn = fakeFetch(() => new Response('{}', { status: 200 }));
    const out = await mintIceServers('', '', fn, new Map(), 'sess-a');
    expect(out).toEqual(STUN_SERVERS);
    expect(fn).not.toHaveBeenCalled();
  });

  it('falls back to STUN-only on a non-2xx response', async () => {
    const fn = fakeFetch(() => new Response('nope', { status: 401 }));
    const out = await mintIceServers('kid-1', 'bad-token', fn, new Map(), 'sess-a');
    expect(out).toEqual(STUN_SERVERS);
  });

  it('falls back to STUN-only on a network error', async () => {
    const fn = fakeFetch(() => Promise.reject(new Error('ECONNRESET')));
    const out = await mintIceServers('kid-1', 'tok-1', fn, new Map(), 'sess-a');
    expect(out).toEqual(STUN_SERVERS);
  });

  it('falls back to STUN-only on an unexpected response shape', async () => {
    const fn = fakeFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    const out = await mintIceServers('kid-1', 'tok-1', fn, new Map(), 'sess-a');
    expect(out).toEqual(STUN_SERVERS);
  });

  it('caches a successful mint per session for 23h, then re-mints', async () => {
    const cfIce = [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' }];
    const fn = fakeFetch(() => new Response(JSON.stringify({ iceServers: cfIce }), { status: 201 }));
    const cache = new Map<string, TurnCacheEntry>();
    let now = 1_000_000;
    const a1 = await mintIceServers('kid-1', 'tok-1', fn, cache, 'sess-a', now);
    expect(a1).toEqual(cfIce);
    expect(fn).toHaveBeenCalledTimes(1);
    now += 60_000; // a minute later, well within the 23h window
    const a2 = await mintIceServers('kid-1', 'tok-1', fn, cache, 'sess-a', now);
    expect(a2).toEqual(cfIce);
    expect(fn).toHaveBeenCalledTimes(1); // reused the cache, no second call
    now += 23 * 60 * 60 * 1000 + 1; // just past the cache window
    await mintIceServers('kid-1', 'tok-1', fn, cache, 'sess-a', now);
    expect(fn).toHaveBeenCalledTimes(2); // re-minted
  });

  it('caches independently per session key', async () => {
    const cfIce = [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' }];
    const fn = fakeFetch(() => new Response(JSON.stringify({ iceServers: cfIce }), { status: 201 }));
    const cache = new Map<string, TurnCacheEntry>();
    await mintIceServers('kid-1', 'tok-1', fn, cache, 'sess-a');
    await mintIceServers('kid-1', 'tok-1', fn, cache, 'sess-b');
    expect(fn).toHaveBeenCalledTimes(2); // different sessions, separate cache entries
  });

  it('never logs the key id, token or response body on failure', async () => {
    const secretToken = 'super-secret-token-xyz';
    const fn = fakeFetch(() => new Response(JSON.stringify({ error: 'contains-a-secret-should-not-leak' }), { status: 403 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mintIceServers('kid-1', secretToken, fn, new Map(), 'sess-a');
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(secretToken);
    expect(logged).not.toContain('contains-a-secret-should-not-leak');
    errSpy.mockRestore();
  });
});

describe('withoutPort53', () => {
  it('drops the alternate port-53 URLs browsers block, and any server left with none', () => {
    const out = withoutPort53([
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' },
      { urls: 'turn:turn.cloudflare.com:53?transport=tcp' },
    ]);
    expect(out).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ]);
  });
});
