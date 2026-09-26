import { afterEach, describe, expect, it, vi } from 'vitest';
import { Supa } from '../src/supa';

interface Call {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

type Scripted = { status: number; body?: unknown };

/** a fake `fetch` that records every call and answers from a script (a fixed response, a queue of
 *  responses per call, or a function of the call count) */
function fakeFetch(script: Scripted | Scripted[] | ((n: number, call: Call) => Scripted)) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(url), init: init as Call['init'] };
    calls.push(call);
    const n = calls.length - 1;
    const r = typeof script === 'function' ? script(n, call) : Array.isArray(script) ? (script[Math.min(n, script.length - 1)]) : script;
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : '', { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const body = (c: Call) => JSON.parse(c.init.body as string);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Supa (disabled)', () => {
  it('is a no-op and never calls fetch when the URL or key is empty', async () => {
    const { fn } = fakeFetch({ status: 200, body: [] });
    const supa = new Supa('', '', { fetch: fn });
    expect(supa.enabled).toBe(false);
    supa.enqueue('activity', { a: 1 });
    await supa.flush();
    expect(await supa.select('game_config', 'select=*')).toEqual([]);
    expect(await supa.rpc('leaderboard_week')).toEqual([]);
    await supa.patch('t', 'id=eq.1', { x: 1 });
    await supa.insert('t', { x: 1 });
    await supa.deleteRows('t', 'id=eq.1');
    await supa.adminDeleteUser('u1');
    await supa.shutdown();
    expect(fn).not.toHaveBeenCalled();
    expect(supa.stats()).toEqual({ pending: 0, dropped: 0 });
  });
});

describe('Supa: direct calls', () => {
  it('select/patch/rpc hit the right URL and headers, apikey only (no Authorization: Bearer)', async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: [] });
    const supa = new Supa('https://proj.supabase.co', 'sb_secret_abc123', { fetch: fn });
    await supa.select('game_config', 'select=key,value');
    await supa.patch('daily_spots', 'day=eq.2026-01-01', { solved_nick: 'Fero' });
    await supa.rpc('leaderboard_week', {});
    expect(calls[0].url).toBe('https://proj.supabase.co/rest/v1/game_config?select=key,value');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers?.apikey).toBe('sb_secret_abc123');
    expect(calls[0].init.headers?.Authorization).toBeUndefined();

    expect(calls[1].url).toBe('https://proj.supabase.co/rest/v1/daily_spots?day=eq.2026-01-01');
    expect(calls[1].init.method).toBe('PATCH');
    expect(calls[1].init.headers?.Prefer).toBe('return=minimal');
    expect(calls[1].init.headers?.apikey).toBe('sb_secret_abc123');
    expect(calls[1].init.headers?.Authorization).toBeUndefined();
    expect(body(calls[1])).toEqual({ solved_nick: 'Fero' });

    expect(calls[2].url).toBe('https://proj.supabase.co/rest/v1/rpc/leaderboard_week');
    expect(calls[2].init.method).toBe('POST');
    expect(calls[2].init.headers?.apikey).toBe('sb_secret_abc123');
    expect(calls[2].init.headers?.Authorization).toBeUndefined();
  });

  it('adminDeleteUser sends Authorization identical to the apikey, never a different token', async () => {
    const { fn, calls } = fakeFetch({ status: 200 });
    const supa = new Supa('https://proj.supabase.co', 'sb_secret_abc123', { fetch: fn });
    await supa.adminDeleteUser('user-123');
    expect(calls[0].url).toBe('https://proj.supabase.co/auth/v1/admin/users/user-123');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.headers?.apikey).toBe('sb_secret_abc123');
    expect(calls[0].init.headers?.Authorization).toBe('Bearer sb_secret_abc123');
  });

  it('select throws (never the key) on a non-2xx response', async () => {
    const { fn } = fakeFetch({ status: 403, body: { code: '42501', message: 'permission denied' } });
    const supa = new Supa('https://proj.supabase.co', 'sb_secret_abc123', { fetch: fn });
    await expect(supa.select('activity', 'select=*')).rejects.toMatchObject({ status: 403, code: '42501' });
  });

  it('select rejects when a 200 response body is not a JSON array, so callers never `for…of` it', async () => {
    const { fn } = fakeFetch({ status: 200, body: { message: 'not an array' } });
    const supa = new Supa('https://proj.supabase.co', 'sb_secret_abc123', { fetch: fn });
    await expect(supa.select('game_config', 'select=key,value')).rejects.toThrow(/expected an array/);
  });
});

describe('Supa: the batched queue', () => {
  it('batches per table: one bulk POST per table with everything queued for it', async () => {
    const { fn, calls } = fakeFetch({ status: 200 });
    const supa = new Supa('https://x.example', 'k', { fetch: fn });
    supa.enqueue('activity', { a: 1 });
    supa.enqueue('activity', { a: 2 });
    supa.enqueue('reports', { r: 1 });
    await supa.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    const byUrl = new Map(calls.map((c) => [c.url, body(c)]));
    expect(byUrl.get('https://x.example/rest/v1/activity')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(byUrl.get('https://x.example/rest/v1/reports')).toEqual([{ r: 1 }]);
    expect(supa.stats()).toEqual({ pending: 0, dropped: 0 });
  });

  it('retries a 500 with exponential backoff (1s, then 2s) under fake timers, then succeeds', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch((n) => (n < 2 ? { status: 500 } : { status: 200 }));
    const supa = new Supa('https://x.example', 'k', { fetch: fn });
    supa.enqueue('activity', { a: 1 });
    await supa.flush(); // attempt 1: 500
    expect(calls.length).toBe(1);
    expect(supa.stats().pending).toBe(1); // kept for retry, not dropped

    await vi.advanceTimersByTimeAsync(999);
    expect(calls.length).toBe(1); // not yet — backoff is 1s, not <1s
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(2); // attempt 2 at +1s: 500 again

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls.length).toBe(2); // not yet — backoff doubled to 2s
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(3); // attempt 3 at +2s more: succeeds

    expect(supa.stats()).toEqual({ pending: 0, dropped: 0 });
    expect(body(calls[2])).toEqual([{ a: 1 }]); // the same row, not duplicated across retries
  });

  it('retries a network error the same way as a 500', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fn = (async () => {
      n++;
      if (n === 1) throw new Error('fetch failed: getaddrinfo ENOTFOUND');
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const supa = new Supa('https://x.example', 'k', { fetch: fn });
    supa.enqueue('activity', { a: 1 });
    await supa.flush();
    expect(supa.stats().pending).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(2);
    expect(supa.stats().pending).toBe(0);
  });

  it('drops the batch on a non-retryable 4xx, counts it, and logs no secret', async () => {
    const key = 'sb_secret_TOTALLY_SECRET_VALUE';
    const { fn } = fakeFetch({ status: 400, body: { code: '23502', message: 'null value in column "kind"' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supa = new Supa('https://x.example', key, { fetch: fn });
    supa.enqueue('activity', { kind: null });
    await supa.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(supa.stats()).toEqual({ pending: 0, dropped: 1 });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(key);
    expect(logged).toContain('400');
    expect(logged).toContain('23502');
  });

  it('caps the queue at 5000 rows, dropping the oldest first', async () => {
    const { fn, calls } = fakeFetch({ status: 200 });
    const supa = new Supa('https://x.example', 'k', { fetch: fn });
    for (let i = 0; i < 5010; i++) supa.enqueue('activity', { i });
    expect(supa.stats()).toEqual({ pending: 5000, dropped: 10 });
    await supa.flush();
    const sent = body(calls[0]) as { i: number }[];
    expect(sent).toHaveLength(5000);
    expect(sent[0].i).toBe(10); // rows 0..9 were the oldest, and are the ones dropped
    expect(sent[sent.length - 1].i).toBe(5009);
  });

  it('shutdown() flushes what is pending, bounded by its timeout', async () => {
    const { fn, calls } = fakeFetch({ status: 200 });
    const supa = new Supa('https://x.example', 'k', { fetch: fn });
    supa.enqueue('activity', { a: 1 });
    await supa.shutdown(3000);
    expect(calls).toHaveLength(1);
    expect(supa.stats().pending).toBe(0);
  });

  it('shutdown() is safe to call concurrently with another shutdown/flush (Activity + index.ts both call it)', async () => {
    let resolveFetch!: (r: Response) => void;
    const fn = (async () => new Promise<Response>((r) => (resolveFetch = r))) as unknown as typeof fetch;
    const supa = new Supa('https://x.example', 'k', { fetch: fn });
    supa.enqueue('activity', { a: 1 });
    const first = supa.shutdown(5000);
    const second = supa.shutdown(5000); // e.g. Activity.shutdown() firing while index.ts also awaits it
    resolveFetch(new Response('', { status: 200 }));
    await Promise.all([first, second]);
    expect(supa.stats().pending).toBe(0);
  });

  it('start()/stop() drive flush on a 5s unref-able interval', async () => {
    vi.useFakeTimers();
    const { fn } = fakeFetch({ status: 200 });
    const supa = new Supa('https://x.example', 'k', { fetch: fn });
    supa.enqueue('activity', { a: 1 });
    supa.start();
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    supa.stop();
    supa.enqueue('activity', { a: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(1); // stopped: no further automatic flush
  });
});
