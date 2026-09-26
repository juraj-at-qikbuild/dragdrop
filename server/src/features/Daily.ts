// "Kde to je?" (docs/plans/social-events.md): once a day, a close-up photo of somewhere in the city
// goes up; the first player to stand on the spot wins. The coordinates live only in
// daily_spot_secrets (read here with the service-role key) and never reach a client — wev.daily and
// every GlobalEvent below carry just the image URL and whatever hints have been revealed so far.
// Without Supabase this feature does nothing beyond the debug injection (onDebug), same as Activity
// and RemoteConfig degrade when it's unset.
import type { Room, Session } from '../Room';
import type { Supa } from '../supa';
import type { RoomFeature } from './RoomFeature';
import type { ClientMsg, WevMsg } from '../../../src/shared/net/protocol';
import type { Level } from '../../../src/shared/world/World';
import { dist } from '../../../src/shared/util/math';
import { addDays, bratislavaDay } from './dailyTime';

/** how often the boot/date-rollover poll runs outside the tick (the only place this feature awaits I/O) */
const POLL_MS = 60_000;
/** minutes after reveal_at that district (1), quarter (2) and street (3) unlock, in order */
const HINT_MINUTES = [20, 40, 60];
/** seconds a player must hold the spot continuously (within its radius, on foot, on its level) to win */
const SOLVE_HOLD_S = 1;
const REWARD = 1000;

const asLevel = (l: unknown): Level => (l === 1 || l === 2 || l === -1 ? l : 0);

interface PublicRow {
  day: string;
  image_path: string;
  reveal_at: string;
  solved_nick: string | null;
  solved_at: string | null;
}
interface SecretRow {
  day: string;
  x: number;
  y: number;
  level: number;
  radius: number;
  kind: string;
  hint_district: string | null;
  hint_quarter: string | null;
  hint_street: string | null;
}

/** everything this feature tracks for one day's puzzle, in memory (nothing here is persisted itself:
 *  hints are re-derived from elapsed time since revealAt, so a restart never loses or repeats one) */
interface Puzzle {
  day: string;
  img: string;
  revealAt: number;
  x: number;
  y: number;
  level: Level;
  radius: number;
  hintDistrict: string | null;
  hintQuarter: string | null;
  hintStreet: string | null;
  solvedNick: string | null;
  /** the dailyReveal GlobalEvent has already gone out for this puzzle */
  revealAnnounced: boolean;
  /** hint texts unlocked so far, in order (what wev.daily.hints sends) */
  hints: string[];
  /** how many of HINT_MINUTES have fired (0..3) */
  hintsGiven: number;
}

export class Daily implements RoomFeature {
  readonly id = 'daily';
  private today: Puzzle | null = null;
  /** yesterday's puzzle, kept only when it went unsolved, so today's reveal can also answer it */
  private yesterdayUnsolved: { x: number; y: number } | null = null;
  private loadedDay = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** player id -> seconds held continuously in the radius; cleared on leaving it (or the day ending) */
  private holding = new Map<number, number>();

  constructor(
    private room: Room,
    private supa: Supa,
  ) {
    void this.poll(); // fire-and-forget: boot never waits on Supabase
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.pollTimer.unref?.();
  }

  /** boot, and every POLL_MS: reload on a Bratislava-date rollover. The only I/O in this feature. */
  private async poll() {
    const day = bratislavaDay(this.room.wallNow());
    if (day === this.loadedDay) return;
    this.loadedDay = day;
    if (!this.supa.enabled) {
      this.today = null;
      this.yesterdayUnsolved = null;
      return;
    }
    try {
      const [pubRows, secretRows] = await Promise.all([
        this.supa.select<PublicRow>('daily_spots', `day=eq.${day}&limit=1`),
        this.supa.select<SecretRow>('daily_spot_secrets', `day=eq.${day}&limit=1`),
      ]);
      this.today = pubRows[0] && secretRows[0] ? this.toPuzzle(pubRows[0], secretRows[0]) : null;

      const yDay = addDays(day, -1);
      const yPub = (await this.supa.select<PublicRow>('daily_spots', `day=eq.${yDay}&limit=1`))[0];
      if (yPub && !yPub.solved_nick) {
        const ySecret = (await this.supa.select<SecretRow>('daily_spot_secrets', `day=eq.${yDay}&limit=1`))[0];
        this.yesterdayUnsolved = ySecret ? { x: ySecret.x, y: ySecret.y } : null;
      } else this.yesterdayUnsolved = null;
    } catch (e) {
      // keep whatever we had (probably nothing yet): a transient Supabase hiccup skips today, not crashes it
      console.error('daily: load failed, keeping the previous state:', e instanceof Error ? e.message : e);
    }
  }

  private toPuzzle(pub: PublicRow, secret: SecretRow): Puzzle {
    return {
      day: pub.day,
      img: `${this.supa.baseUrl}/storage/v1/object/public/spots/${pub.image_path}`,
      revealAt: Date.parse(pub.reveal_at),
      x: secret.x,
      y: secret.y,
      level: asLevel(secret.level),
      radius: secret.radius,
      hintDistrict: secret.hint_district,
      hintQuarter: secret.hint_quarter,
      hintStreet: secret.hint_street,
      solvedNick: pub.solved_nick,
      revealAnnounced: false,
      hints: [],
      hintsGiven: 0,
    };
  }

  /** msg.daily {x, y, r}: a spot for today, revealed right away, no Supabase involved (tests, e2e) */
  onDebug(_s: Session, m: Extract<ClientMsg, { t: 'debug' }>) {
    if (!m.daily) return;
    const w = this.room.sim.world;
    const { x, y, r } = m.daily;
    this.today = {
      day: bratislavaDay(this.room.wallNow()),
      img: '',
      revealAt: this.room.wallNow(),
      x,
      y,
      level: 0,
      radius: r,
      hintDistrict: w.district(x, y),
      hintQuarter: w.quarter(x, y),
      hintStreet: w.streetName(x, y),
      solvedNick: null,
      revealAnnounced: false,
      hints: [],
      hintsGiven: 0,
    };
    this.yesterdayUnsolved = null;
    this.holding.clear();
  }

  tick(dtMs: number) {
    const p = this.today;
    if (!p) return;
    const now = this.room.wallNow();
    if (now < p.revealAt) return;

    if (!p.revealAnnounced) {
      p.revealAnnounced = true;
      this.room.sim.events.global({ k: 'dailyReveal', img: p.img });
      if (this.yesterdayUnsolved) {
        this.room.sim.events.global({ k: 'dailyAnswer', x: this.yesterdayUnsolved.x, y: this.yesterdayUnsolved.y });
        this.yesterdayUnsolved = null;
      }
      this.room.director?.changed();
    }
    if (p.solvedNick) return;

    const elapsedMin = (now - p.revealAt) / 60_000;
    while (p.hintsGiven < HINT_MINUTES.length && elapsedMin >= HINT_MINUTES[p.hintsGiven]) {
      const level = ++p.hintsGiven; // 1 = district, 2 = quarter, 3 = street
      const text = level === 1 ? p.hintDistrict : level === 2 ? p.hintQuarter : p.hintStreet;
      if (text) {
        p.hints.push(hintLine(level, text));
        this.room.sim.events.global({ k: 'dailyHint', level, text });
        this.room.director?.changed();
      }
    }

    for (const s of this.room.sessions.values()) {
      const pl = s.player;
      const onSpot = pl.state === 'play' && !pl.ped.vehicle && pl.ped.level === p.level && dist(pl.ped.x, pl.ped.y, p.x, p.y) <= p.radius;
      if (!onSpot) {
        this.holding.delete(pl.id);
        continue;
      }
      const held = (this.holding.get(pl.id) ?? 0) + dtMs / 1000;
      if (held < SOLVE_HOLD_S) {
        this.holding.set(pl.id, held);
        continue;
      }
      this.solve(p, s);
      break; // the first to cross the line wins; no second winner this tick or any later one
    }
  }

  private solve(p: Puzzle, s: Session) {
    const pl = s.player;
    p.solvedNick = pl.nick;
    this.holding.clear();
    this.room.sim.payout(pl, REWARD, 'daily');
    pl.profile.stats ??= {};
    pl.profile.stats.dailyWins = (pl.profile.stats.dailyWins ?? 0) + 1;
    this.room.sim.events.global({ k: 'dailySolved', nick: pl.nick });
    this.room.director?.changed();
    void this.supa.patch('daily_spots', `day=eq.${p.day}`, { solved_nick: pl.nick, solved_at: new Date(this.room.wallNow()).toISOString() });
    this.room.activity?.log('daily', s, REWARD, { day: p.day });
  }

  wev(out: WevMsg) {
    const p = this.today;
    out.daily = p && this.room.wallNow() >= p.revealAt ? { day: p.day, img: p.img, hints: p.hints.slice(), solvedBy: p.solvedNick } : null;
  }

  shutdown() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

const HINT_LABEL = ['', 'Mestská časť', 'Štvrť', 'Ulica'];
const hintLine = (level: number, text: string) => `${HINT_LABEL[level]}: ${text}`;
