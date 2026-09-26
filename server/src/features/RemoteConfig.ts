// game_config from Supabase: remote tunables and kill switches for voice chat and the world-event
// director, loaded at boot and refreshed every minute (docs/plans/social-events.md). Falls back to
// hardcoded defaults when Supabase is unset, unreachable, or a value is missing or the wrong shape —
// a bad or absent row skips just that one field, never the whole reload.
import type { Room } from '../Room';
import type { Supa } from '../supa';
import type { RoomFeature } from './RoomFeature';

/** world-event tunables (game_config's 'events' key); an absent or malformed field just keeps
 *  whatever the director already had */
export interface EventsTuning {
  gap?: [number, number];
  offlineGap?: [number, number];
  first?: [number, number];
  retry?: number;
  enabled?: boolean;
}

export interface Config {
  voice_enabled: boolean;
  voice_requires_account: boolean;
  voice_blocklist: string[];
  events: EventsTuning;
}

const DEFAULTS: Config = { voice_enabled: true, voice_requires_account: true, voice_blocklist: [], events: {} };
const REFRESH_MS = 60_000;

type Row = { key: string; value: unknown };

export class RemoteConfig implements RoomFeature {
  readonly id = 'remoteConfig';
  private values: Config = { ...DEFAULTS };
  private listeners = new Set<(v: Config) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** e2e (config.e2e or RoomOptions.debug) relaxes voice_requires_account so the voice e2e can run
   *  without accounts; null means "use whatever game_config (or the default) says" */
  private voiceAccountOverride: boolean | null = null;

  constructor(
    private room: Room,
    readonly supa: Supa,
    opts: { e2e?: boolean } = {},
  ) {
    if (opts.e2e) this.voiceAccountOverride = false;
    void this.load().catch(logLoadFailure); // fire-and-forget: boot never waits on Supabase
    if (supa.enabled) {
      this.timer = setInterval(() => void this.load().catch(logLoadFailure), REFRESH_MS);
      this.timer.unref?.();
    }
  }

  get<K extends keyof Config>(key: K): Config[K] {
    if (key === 'voice_requires_account' && this.voiceAccountOverride !== null) return this.voiceAccountOverride as Config[K];
    return this.values[key];
  }

  /** notified with the full config after every successful reload; returns an unsubscribe function */
  onChange(fn: (v: Config) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** test-only (and the e2e boot path, see the constructor): force voice_requires_account regardless
   *  of what game_config says; null restores the normal (fetched-or-default) value */
  setVoiceRequiresAccountOverride(v: boolean | null) {
    this.voiceAccountOverride = v;
  }

  private async load() {
    if (!this.supa.enabled) return;
    // everything that touches `rows` stays inside the try: a 200 with a non-array body (Supa.select()
    // normally rejects on that itself, but this is the second line of defence) must be treated the
    // same as a failed fetch, never thrown past this function as an unhandled rejection.
    try {
      const rows = await this.supa.select<Row>('game_config', 'select=key,value');
      const next: Config = { ...this.values };
      for (const r of rows) {
        const v = r.value;
        switch (r.key) {
          case 'voice_enabled':
            if (typeof v === 'boolean') next.voice_enabled = v;
            break;
          case 'voice_requires_account':
            if (typeof v === 'boolean') next.voice_requires_account = v;
            break;
          case 'voice_blocklist':
            if (Array.isArray(v) && v.every((x) => typeof x === 'string')) next.voice_blocklist = v;
            break;
          case 'events':
            if (v && typeof v === 'object' && !Array.isArray(v)) next.events = v as EventsTuning;
            break;
        }
      }
      this.values = next;
      this.applyEvents(next.events);
      for (const fn of this.listeners) fn(next);
    } catch (e) {
      console.error('remote config: fetch failed, keeping the last known values:', e instanceof Error ? e.message : e);
    }
  }

  /** copy the validated tunables onto the director, one field at a time, so a partly-bad `events`
   *  value still applies whatever part of it is good */
  private applyEvents(events: EventsTuning) {
    const dir = this.room.director;
    if (!dir) return;
    if (isRange(events.gap)) dir.config.gap = events.gap;
    if (isRange(events.offlineGap)) dir.config.offlineGap = events.offlineGap;
    if (isRange(events.first)) dir.config.first = events.first;
    if (typeof events.retry === 'number' && Number.isFinite(events.retry) && events.retry > 0) dir.config.retry = events.retry;
    if (typeof events.enabled === 'boolean') dir.config.enabled = events.enabled;
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** load() already catches and logs its own failures; this only guards the fire-and-forget call sites
 *  against a future change there ever throwing past it (docs/plans/social-events.md: fire-and-forget
 *  I/O always carries a `.catch`) */
function logLoadFailure(e: unknown) {
  console.error('remote config: unexpected load failure:', e instanceof Error ? e.message : e);
}
