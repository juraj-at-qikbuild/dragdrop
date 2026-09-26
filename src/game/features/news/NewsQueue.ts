// A tiny priority queue for the radio's breaking news: at most one line every 20 s, the highest
// priority waiting line goes out first (it "jumps" ahead of lower-priority chatter already queued),
// a line older than 60 s is dropped before it's ever read, at most 5 wait at once, and the same line
// repeating within 5 minutes is skipped so a chatty event (a van changing hands, say) doesn't spam
// the DJ. Pure and DOM-free: `now` is always passed in, never read from the clock, so it's trivial
// to drive from a test.
// Plan: docs/plans/social-events.md ("Rádio Kecy breaking news")
import type { NewsLine } from './lines';

const MIN_GAP_MS = 20_000;
const MAX_AGE_MS = 60_000;
const MAX_ITEMS = 5;
const DEDUP_MS = 5 * 60_000;

interface Queued extends NewsLine {
  at: number;
}

export class NewsQueue {
  private items: Queued[] = [];
  private lastShown = -Infinity;
  /** text -> the last time it was accepted (pushed or shown), for the 5-minute repeat guard */
  private seen = new Map<string, number>();

  /** Queue a formatted line. Silently dropped when the same text was already accepted within the
   *  last 5 minutes, so a fast-changing "holder" line doesn't repeat itself every tick. */
  push(item: NewsLine, now: number) {
    const last = this.seen.get(item.text);
    if (last !== undefined && now - last < DEDUP_MS) return;
    this.seen.set(item.text, now);
    // entries past the dedupe window can never affect the check above again: drop them so a long
    // session (many distinct texts, e.g. amounts/nicks baked in) doesn't grow this forever
    for (const [text, at] of this.seen) if (now - at >= DEDUP_MS) this.seen.delete(text);
    this.items.push({ ...item, at: now });
    this.dropOld(now);
    while (this.items.length > MAX_ITEMS) {
      // over capacity: drop the least newsworthy line (lowest priority, then oldest)
      let worst = 0;
      for (let i = 1; i < this.items.length; i++) {
        const a = this.items[i], b = this.items[worst];
        if (a.priority < b.priority || (a.priority === b.priority && a.at < b.at)) worst = i;
      }
      this.items.splice(worst, 1);
    }
  }

  /** The next line to read out, or `null` when it isn't time yet (the 20 s gate) or nothing is
   *  queued. Among waiting lines it always picks the highest priority one (ties: the oldest), which
   *  is how a big story "jumps the queue" ahead of small talk that arrived first. */
  next(now: number): string | null {
    this.dropOld(now);
    if (!this.items.length || now - this.lastShown < MIN_GAP_MS) return null;
    let best = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i], b = this.items[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.at < b.at)) best = i;
    }
    const [chosen] = this.items.splice(best, 1);
    this.lastShown = now;
    return chosen.text;
  }

  private dropOld(now: number) {
    this.items = this.items.filter((i) => now - i.at <= MAX_AGE_MS);
  }

  /** how many lines are currently waiting (tests only; News.ts never needs this) */
  get size(): number {
    return this.items.length;
  }
}
