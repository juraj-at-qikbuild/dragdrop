// Súrna potreba (docs/plans/minigames.md): the Old Town has hardly any public toilets, half of those
// are locked whatever the sign says, the paid ones want coins, and a café's is "only for customers".
// The bladder fills; find one that works before it's full. Running and a bumpy ride make it worse.
//
// The public toilets are the map's own (places 'wc'); each one here is free, paid (50 centov, in
// coins) or locked, which a player only finds out at the door. A café lets a customer in (a coffee,
// €3, which also gives change); a bakery changes money (a rožok, €1). One player at a time in each.
// With others it's a race: the first one relieved wins, and everyone who makes it gets paid.
import { dist, hypot } from '../../../../util/math';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';

/** toilets it looks for, and how far from the start (m) */
const WC_MAX = 8, WC_R = 1100;
/** cafés and bakeries, and how far (m) */
const CAFE_MAX = 6, CAFE_R = 650, BAKERY_MAX = 4, BAKERY_R = 650;
/** the bladder at the start, and how fast it fills (per second) walking, running, riding */
const START = 0.3;
const FILL = 1 / 150, RUN = 1.7, RIDE = 1.35, SWIM = 2.2;
/** a toilet's sign reads from this far (m) */
const SEE = 12;
/** the action key reaches this far (m) */
const REACH = 6;
/** relief takes this long (s), and stays within this far (m) */
const RELIEF_S = 4, RELIEF_R = 8;
/** what the paid toilet, a coffee and a rožok cost (€) */
const TOILET_FEE = 1, COFFEE = 3, ROLL = 1;
/** at worst it's over this long after it started (s) */
const MAX_S = 300;
/** pay: made it, plus the room left in the bladder, plus the place with others */
const PAY_BASE = 60, PAY_MARGIN = 70, PLACE_BONUS = [70, 35, 15];

type Status = 'free' | 'paid' | 'locked';

interface Spot {
  x: number;
  y: number;
  kind: 'wc' | 'cafe' | 'bakery';
  status: Status;
  /** in use by this player id until sim.time `until` */
  by: number;
  until: number;
}

interface Player {
  bladder: number;
  coins: number;
  /** the toilets they've seen the sign of */
  seen: Set<number>;
  /** relieving at spot `at` since `t` */
  relief: { at: number; t: number } | null;
  done: boolean;
  failed: boolean;
  /** how full they were at the end */
  final: number;
}

class Toilet extends MiniGame {
  private spots: Spot[] = [];
  private state = new Map<number, Player>();
  private finished = 0;

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = MAX_S;
  }

  /** the toilets, cafés and bakeries around (x, y); false when there's no toilet anywhere near */
  pick(x: number, y: number): boolean {
    const w = this.sim.world, rng = this.sim.rng;
    const near = (kind: string, r: number, max: number) =>
      w.places(kind)
        .map((p) => ({ p, d: dist(p.x, p.y, x, y) }))
        .filter((o) => o.d <= r && o.d > 25 && w.spawnLevel(o.p.x, o.p.y, 0.5) === 0)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
        .map((o) => o.p);
    const wcs = near('wc', WC_R, WC_MAX);
    if (wcs.length < 2) return false;
    for (const p of wcs) {
      const r = rng.next();
      this.spots.push({ x: p.x, y: p.y, kind: 'wc', status: r < 0.2 ? 'free' : r < 0.6 ? 'paid' : 'locked', by: 0, until: 0 });
    }
    // at least one of them works, and it's never the nearest one (that would be too easy)
    if (this.spots.every((s) => s.status === 'locked')) this.spots[this.spots.length - 1].status = 'paid';
    for (const p of near('cafe', CAFE_R, CAFE_MAX)) this.spots.push({ x: p.x, y: p.y, kind: 'cafe', status: 'free', by: 0, until: 0 });
    for (const p of near('bakery', BAKERY_R, BAKERY_MAX)) this.spots.push({ x: p.x, y: p.y, kind: 'bakery', status: 'free', by: 0, until: 0 });
    return true;
  }

  start() {
    for (const p of this.players) this.onJoin(p);
    this.tell('Musíš! Nájdi WC, kým nie je neskoro.', '#ffd740', 3);
  }

  onJoin(p: SimPlayer) {
    if (!this.state.has(p.id)) this.state.set(p.id, { bladder: START, coins: 0, seen: new Set(), relief: null, done: false, failed: false, final: 0 });
  }

  update(dt: number) {
    const now = this.sim.time;
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s || s.done || s.failed) continue;
      const ped = p.ped, car = ped.vehicle;
      // what they can read from where they are
      for (let i = 0; i < this.spots.length; i++) {
        const sp = this.spots[i];
        if (sp.kind === 'wc' && !s.seen.has(i) && dist(sp.x, sp.y, ped.x, ped.y) <= SEE) s.seen.add(i);
      }
      if (s.relief) {
        const sp = this.spots[s.relief.at];
        if (car || dist(sp.x, sp.y, ped.x, ped.y) > RELIEF_R) {
          // walked off in the middle of it
          s.relief = null;
          sp.by = 0;
          this.msg(p, 'Odišiel si – ešte stále musíš!', '#ff8a80');
          continue;
        }
        s.bladder = Math.max(0, s.bladder - dt / RELIEF_S);
        if (now - s.relief.t >= RELIEF_S) this.relieved(p, s, sp);
        continue;
      }
      const running = !car && hypot(ped.vx, ped.vy) > 2.6;
      const rate = this.sim.world.inWater(ped.x, ped.y, ped.level) && !car ? SWIM : car ? RIDE : running ? RUN : 1;
      s.bladder += FILL * rate * dt;
      s.final = s.bladder;
      if (s.bladder >= 1) this.fail(p, s);
    }
    for (const sp of this.spots) if (sp.by && now >= sp.until && !this.inUse(sp)) sp.by = 0;
    if (this.players.every((p) => this.state.get(p.id)?.done || this.state.get(p.id)?.failed)) this.finish();
  }

  /** someone's relieving there right now */
  private inUse(sp: Spot) {
    return this.players.some((p) => {
      const s = this.state.get(p.id);
      return !!s?.relief && this.spots[s.relief.at] === sp;
    });
  }

  private relieved(p: SimPlayer, s: Player, sp: Spot) {
    s.relief = null;
    s.done = true;
    sp.by = 0;
    const place = ++this.finished;
    const margin = Math.max(0, 1 - s.final);
    const group = this.round.started >= 2;
    const pay = PAY_BASE + margin * PAY_MARGIN + (group ? (PLACE_BONUS[place - 1] ?? 0) : 0);
    this.addPoints(p, 1000 - place * 10 + Math.round(margin * 9));
    const where = sp.kind === 'cafe' ? 'v kaviarni' : 'na verejnom WC';
    this.outcome(p, { pay, text: group ? `${place}. na toalete ${where}! Úľava.` : `Stihol si to ${where}! Úľava.` });
    this.pop(p, 'ÚĽAVA!', p.ped.x, p.ped.y - 1.7);
    if (group) for (const q of this.players) if (q !== p) this.msg(q, `${p.nick} to stihol${place === 1 ? ' prvý' : ''}!`, '#ffd740');
  }

  private fail(p: SimPlayer, s: Player) {
    s.failed = true;
    s.bladder = 1;
    this.outcome(p, { pay: 0, text: 'Nestihol si to… 💦' });
    this.msg(p, 'Nestihol si to… 💦', '#ff5252', 3);
  }

  onLeave(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (s?.relief) this.spots[s.relief.at].by = 0;
    this.state.delete(p.id);
  }

  // ------------------------------------------------------------------------------ the action
  /** the spot `p` is at (within reach): the nearest one */
  private at(p: SimPlayer): number {
    let best = -1, bd = REACH;
    for (let i = 0; i < this.spots.length; i++) {
      const d = dist(this.spots[i].x, this.spots[i].y, p.ped.x, p.ped.y);
      if (d <= bd) (bd = d), (best = i);
    }
    return best;
  }

  private actionAt(p: SimPlayer, s: Player): string | undefined {
    if (s.done || s.failed || s.relief || p.ped.vehicle) return undefined;
    const i = this.at(p);
    if (i < 0) return undefined;
    const sp = this.spots[i];
    if (sp.kind === 'bakery') return `Kúpiť rožok a rozmeniť (€${ROLL})`;
    if (sp.kind === 'cafe') return `Kúpiť kávu – WC pre zákazníkov (€${COFFEE})`;
    if (sp.status === 'paid') return s.coins ? 'Zaplatiť 50 centov a ísť' : 'WC – treba drobné';
    return 'Skúsiť dvere';
  }

  act(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (!s || s.done || s.failed || s.relief) return;
    if (p.ped.vehicle) return this.msg(p, 'Najprv vystúp.');
    const i = this.at(p);
    if (i < 0) return;
    const sp = this.spots[i];
    s.seen.add(i);
    if (sp.kind === 'bakery') {
      if (p.profile.money < ROLL) return this.msg(p, 'Nemáš ani na rožok.', '#ff8a80');
      this.sim.addMoney(p, -ROLL);
      s.coins += 2;
      return this.msg(p, 'Rožok a hrsť drobných. 🥐', '#69f0ae');
    }
    if (sp.kind === 'wc' && sp.status === 'locked') return this.msg(p, 'Zamknuté. Otváracie hodiny sú len na papieri.', '#ff8a80');
    if (sp.by && sp.by !== p.id && this.sim.time < sp.until) return this.msg(p, 'Obsadené! Niekto ťa predbehol.', '#ffd740');
    if (sp.kind === 'cafe') {
      if (p.profile.money < COFFEE) return this.msg(p, 'Na kávu nemáš – a bez nej ťa nepustia.', '#ff8a80');
      this.sim.addMoney(p, -COFFEE);
      s.coins += 1;
      this.msg(p, 'Káva zaplatená, WC je tvoje.', '#69f0ae');
    } else if (sp.status === 'paid') {
      if (!s.coins) return this.msg(p, 'Nemáš drobné! Rozmeň si v pekárni alebo kaviarni.', '#ff8a80');
      s.coins--;
      this.sim.addMoney(p, -TOILET_FEE);
      this.msg(p, 'Pani pri dverách si zobrala drobné.', '#69f0ae');
    }
    sp.by = p.id;
    sp.until = this.sim.time + RELIEF_S + 1;
    s.relief = { at: i, t: this.sim.time };
  }

  // --------------------------------------------------------------------------------- the view
  view(p: SimPlayer): MiniView {
    const s = this.state.get(p.id);
    if (!s) return { goal: 'Súrna potreba' };
    const marks: MiniMark[] = [];
    let arrow = -1, ad = Infinity;
    for (let i = 0; i < this.spots.length; i++) {
      const sp = this.spots[i];
      const d = dist(sp.x, sp.y, p.ped.x, p.ped.y);
      if (sp.kind === 'wc') {
        const known = s.seen.has(i);
        if ((!known || sp.status !== 'locked') && d < ad) (ad = d), (arrow = marks.length);
        marks.push(
          !known
            ? { x: sp.x, y: sp.y, icon: '🚻', label: '?', color: '#b0bec5', r: 3 }
            : sp.status === 'locked'
              ? { x: sp.x, y: sp.y, icon: '🔒', label: 'zamknuté', color: '#ff5252', r: 3, dim: 1 }
              : { x: sp.x, y: sp.y, icon: '🚻', label: sp.status === 'free' ? 'zadarmo' : '50 centov', color: sp.status === 'free' ? '#69f0ae' : '#ffd740', r: 3 },
        );
      } else if (sp.kind === 'cafe') marks.push({ x: sp.x, y: sp.y, icon: '☕', label: 'len pre zákazníkov', color: '#bcaaa4', r: 2.5 });
      else marks.push({ x: sp.x, y: sp.y, icon: '🥐', label: 'rozmeň', color: '#ffcc80', r: 2.5, noMap: 1 });
      if (sp.by && sp.by !== p.id) marks[marks.length - 1].label = 'obsadené';
    }
    if (arrow >= 0 && !s.done && !s.failed) marks[arrow].arrow = 1;
    const goal = s.done
      ? 'Hotovo. Počkaj na ostatných.'
      : s.failed
        ? 'Nestihol si to…'
        : s.relief
          ? 'Ahh… vydrž ešte chvíľu.'
          : p.ped.vehicle
            ? 'Nájdi WC – a vystúp, autom sa ti tam nezmestí.'
            : 'Nájdi WC, ktoré je otvorené. Nebež – je to horšie.';
    return {
      goal,
      bar: { label: 'Mechúr', v: Math.min(1, s.bladder), color: s.bladder > 0.8 ? '#ff5252' : s.bladder > 0.55 ? '#ffb300' : '#4fc3f7' },
      stats: [['Drobné', `${s.coins}×`], ['Peniaze', `€${Math.floor(p.profile.money)}`]],
      marks,
      act: this.actionAt(p, s),
    };
  }

  lobbyView(): MiniView {
    return { goal: 'Kofola, dve pivá a veľká voda… Už to prichádza.' };
  }
}

export const TOILET_DEF: MiniGameDef = {
  kind: 'toilet',
  lobby: 20,
  create(sim, round) {
    const g = new Toilet(sim, round);
    return g.pick(round.x, round.y) ? g : 'Tu široko-ďaleko nie je verejné WC – skús v Starom Meste.';
  },
};
