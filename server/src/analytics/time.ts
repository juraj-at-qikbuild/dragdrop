import { addDays, bratislavaDay, bratislavaMidnight } from '../features/dailyTime';
import type { PlayDay } from './types';

let cached = { day: '', start: 0, end: 0 };
function calendar(at: number) {
  if (at < cached.start || at >= cached.end) {
    const day = bratislavaDay(at);
    cached = { day, start: bratislavaMidnight(day), end: bratislavaMidnight(addDays(day, 1)) };
  }
  return cached;
}

/** Split wall-clock placement without using it to measure duration (the caller uses a monotonic clock). */
export function addInterval(days: PlayDay[], start: number, duration: number, activeDuration: number, measured: boolean) {
  let at = start, left = Math.max(0, duration), activeLeft = Math.max(0, activeDuration);
  while (left > 0) {
    const { day, end: boundary } = calendar(at);
    const ms = Math.min(left, Math.max(1, boundary - at));
    let row = days.find(d => d.day === day);
    if (!row) { row = { day, connected_ms: 0, active_ms: 0, measured_ms: 0 }; days.push(row); }
    row.connected_ms += ms;
    row.active_ms += Math.min(ms, activeLeft);
    if (measured) row.measured_ms += ms;
    activeLeft = Math.max(0, activeLeft - ms);
    left -= ms; at += ms;
  }
}
