// What this device played last, for the main menu's "Pokračovať online" (docs/plans/pause-resume.md):
// online or single-player, and when and where it was last online (the street the HUD showed). Kept in
// localStorage; without it the menu just shows the plain Online button.
import { RESUME_MS } from '../shared/net/protocol';

const KEY = 'blava-city-last-played';

export interface LastPlayed {
  mode: 'online' | 'offline';
  /** the last online session: when (ms since the epoch) and where (a square, street or district; may be '') */
  online: { at: number; place: string } | null;
}

export function loadLastPlayed(): LastPlayed | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastPlayed>;
    if (v.mode !== 'online' && v.mode !== 'offline') return null;
    const o = v.online;
    const online = o && typeof o.at === 'number' && Number.isFinite(o.at) && typeof o.place === 'string' ? { at: o.at, place: o.place.slice(0, 60) } : null;
    return { mode: v.mode, online };
  } catch {
    return null;
  }
}

function save(v: LastPlayed) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the menu shows the plain Online button next time */
  }
}

/** playing online right now, here (on the welcome, every so often while online, and on leaving) */
export function noteOnline(place: string, now = Date.now()) {
  save({ mode: 'online', online: { at: now, place } });
}

/** a single-player game started: the menu puts single-player first next time */
export function noteOffline() {
  save({ mode: 'offline', online: loadLastPlayed()?.online ?? null });
}

/** "pred chvíľou", "pred 12 min", "pred 3 h", "pred 1 dňom", "pred 2 dňami" */
export function agoText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'pred chvíľou';
  if (min < 60) return `pred ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `pred ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'pred 1 dňom' : `pred ${d} dňami`;
}

/** The "Pokračovať online" subtitle: where and when, while the server still keeps that spot
 *  (RESUME_MS); '' otherwise, since they'd start out on the square. */
export function continueNote(last: LastPlayed | null, now = Date.now()): string {
  const o = last?.online;
  if (!o || now - o.at >= RESUME_MS) return '';
  const ago = agoText(now - o.at);
  return o.place ? `${o.place} · ${ago}` : ago;
}
