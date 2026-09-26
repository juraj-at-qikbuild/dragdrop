// A tiny Supabase REST client: plain `fetch` against PostgREST, Storage and the Auth admin API, no
// supabase-js (docs/plans/social-events.md). The server only ever holds the secret key, which
// PostgREST treats as service_role (bypasses RLS) when sent as `apikey`; the new `sb_secret_...` keys
// aren't JWTs, so they never go in `Authorization: Bearer` — except GoTrue's admin API, which (unlike
// PostgREST) still checks Authorization too, so that one call sends the very same key there, never a
// different, JWT-shaped token.
// Reads and one-shot writes (select/patch/insert/rpc/deleteRows/adminDeleteUser) are plain awaited
// calls for the few things that need a fresh answer; everything routine and high-volume (activity,
// reports) goes through the batched `enqueue` queue instead, which is never awaited from the tick and
// never throws into its caller.
export interface SupaOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** every network call gives up after this long, so a stalled Supabase never stalls a caller */
const TIMEOUT_MS = 10_000;
const FLUSH_MS = 5_000;
const MAX_QUEUE_ROWS = 5_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** a PostgREST error body, when the response has one */
interface RestErrorBody {
  code?: string;
  message?: string;
}

/** thrown by the direct (non-queued) calls below; built only from the status and PostgREST's own
 *  error body, so it can never carry the key */
export class SupaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'SupaError';
  }
}

interface QueueEntry {
  table: string;
  row: object;
}

export class Supa {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private queue: QueueEntry[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** current backoff for a table that's failing (network error, 5xx or 429); absent = not backing off */
  private backoff = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** the in-flight send per table, so a concurrent flush() (shutdown() can race the interval, or
   *  Activity's own shutdown()) awaits the same request instead of starting a second one */
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly url: string,
    private readonly key: string,
    opts: SupaOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** false when unconfigured: every method below becomes a no-op or returns empty */
  get enabled(): boolean {
    return !!this.url && !!this.key;
  }

  // --------------------------------------------------------------------------------- direct calls
  select<T>(table: string, query: string): Promise<T[]> {
    if (!this.enabled) return Promise.resolve([]);
    return this.json<T[]>('select', table, `/rest/v1/${table}?${query}`, { method: 'GET', headers: this.headers(false) });
  }

  async patch(table: string, match: string, values: object): Promise<void> {
    if (!this.enabled) return;
    const res = await this.request(`/rest/v1/${table}?${match}`, {
      method: 'PATCH', headers: { ...this.headers(true), Prefer: 'return=minimal' }, body: JSON.stringify(values),
    });
    if (!res.ok) throw await this.errorFor('patch', table, res);
  }

  /** immediate (unbatched) insert; enqueue() below is the batched path for high-volume writes */
  async insert(table: string, rows: object | object[]): Promise<void> {
    if (!this.enabled) return;
    const res = await this.request(`/rest/v1/${table}`, {
      method: 'POST', headers: { ...this.headers(true), Prefer: 'return=minimal' }, body: JSON.stringify(rows),
    });
    if (!res.ok) throw await this.errorFor('insert', table, res);
  }

  rpc<T>(fn: string, args: object = {}): Promise<T> {
    if (!this.enabled) return Promise.resolve([] as unknown as T);
    return this.json<T>('rpc', fn, `/rest/v1/rpc/${fn}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(args) });
  }

  async deleteRows(table: string, match: string): Promise<void> {
    if (!this.enabled) return;
    const res = await this.request(`/rest/v1/${table}?${match}`, { method: 'DELETE', headers: this.headers(false) });
    if (!res.ok) throw await this.errorFor('deleteRows', table, res);
  }

  /** GDPR account deletion (the accounts feature). GoTrue's admin API, unlike PostgREST, also checks
   *  Authorization, so it gets the same secret key there too — never a different, JWT-shaped token. */
  async adminDeleteUser(userId: string): Promise<void> {
    if (!this.enabled) return;
    const res = await this.request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE', headers: { apikey: this.key, Authorization: `Bearer ${this.key}` },
    });
    if (!res.ok) throw await this.errorFor('adminDeleteUser', userId, res);
  }

  private async json<T>(op: string, subject: string, path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw await this.errorFor(op, subject, res);
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------------------------ the batched queue
  /** queue a row for `table`; rows are dropped from the front (oldest first) once 5,000 are pending
   *  (stats() counts them) so a long Supabase outage can't grow this without bound */
  enqueue(table: string, row: object) {
    if (!this.enabled) return;
    this.queue.push({ table, row });
    while (this.queue.length > MAX_QUEUE_ROWS) {
      this.queue.shift();
      this.dropped++;
    }
  }

  /** one bulk POST per table with pending rows. Safe to call again while a previous flush is still in
   *  flight (shutdown() and the interval can race) and a no-op when there's nothing queued. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    const tables = new Set(this.queue.map((e) => e.table));
    await Promise.all([...tables].map((t) => this.flushTable(t)));
  }

  private flushTable(table: string): Promise<void> {
    const running = this.inflight.get(table);
    if (running) return running;
    if (this.retryTimers.has(table)) return Promise.resolve(); // backing off: its own timer will retry
    const rows = this.rowsFor(table);
    if (!rows.length) return Promise.resolve();
    const p = this.sendBatch(table, rows).finally(() => this.inflight.delete(table));
    this.inflight.set(table, p);
    return p;
  }

  private rowsFor(table: string): object[] {
    return this.queue.filter((e) => e.table === table).map((e) => e.row);
  }

  private async sendBatch(table: string, rows: object[]): Promise<void> {
    let res: Response;
    try {
      res = await this.request(`/rest/v1/${table}`, { method: 'POST', headers: { ...this.headers(true), Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    } catch {
      this.retryLater(table); // network error or timeout: retryable, same as a 5xx
      return;
    }
    if (res.ok) {
      this.removeSent(table, rows);
      this.backoff.delete(table);
      return;
    }
    if (res.status === 429 || res.status >= 500) return this.retryLater(table);
    // a non-retryable 4xx would just fail again the same way: drop the batch and say why, never the key
    this.removeSent(table, rows);
    this.backoff.delete(table);
    this.dropped += rows.length;
    const body = await safeJson<RestErrorBody>(res);
    const at = new Date(this.now()).toISOString();
    console.error(`supa: dropped ${rows.length} row(s) for ${table} at ${at} (${res.status}${body.code ? ' ' + body.code : ''}${body.message ? ': ' + body.message : ''})`);
  }

  private removeSent(table: string, sent: object[]) {
    const s = new Set(sent);
    this.queue = this.queue.filter((e) => e.table !== table || !s.has(e.row));
  }

  private retryLater(table: string) {
    const prev = this.backoff.get(table) ?? 0;
    const ms = prev ? Math.min(prev * 2, MAX_BACKOFF_MS) : MIN_BACKOFF_MS;
    this.backoff.set(table, ms);
    const timer = setTimeout(() => {
      this.retryTimers.delete(table);
      void this.flushTable(table);
    }, ms);
    timer.unref?.();
    this.retryTimers.set(table, timer);
  }

  /** numbers for /stats */
  stats() {
    return { pending: this.queue.length, dropped: this.dropped };
  }

  start() {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** deploy/SIGTERM: give up on any backoff wait and make one last attempt right away, bounded so
   *  shutdown can't hang on a Supabase outage. Safe to call more than once (Activity.shutdown() and
   *  index.ts's SIGTERM handler both do): the second call coalesces onto the same in-flight sends. */
  async shutdown(timeoutMs = 3000): Promise<void> {
    this.stop();
    for (const [table, timer] of this.retryTimers) {
      clearTimeout(timer);
      this.retryTimers.delete(table);
    }
    await Promise.race([this.flush(), delay(timeoutMs)]);
  }

  // ------------------------------------------------------------------------------------- internals
  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key };
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }

  private async request(path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      return await this.fetchFn(this.url + path, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async errorFor(op: string, subject: string, res: Response): Promise<SupaError> {
    const body = await safeJson<RestErrorBody>(res);
    return new SupaError(res.status, body.code, `supa.${op}(${subject}): ${res.status}${body.message ? ' ' + body.message : ''}`);
  }
}

async function safeJson<T>(res: Response): Promise<Partial<T>> {
  try {
    return (await res.json()) as T;
  } catch {
    return {};
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
