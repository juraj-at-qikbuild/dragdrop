// AKCIA! Maslo (docs/plans/minigames.md): in October 2024 a 250 g block of butter cost up to €4.29, and
// the whole city hunted the "akcie" in the supermarkets' apps. Now one of them has it for €1.49 — while
// stocks last, ten a person — and the grannies were at the door before the flyer was out. Get there,
// get past them, buy, and sell the butter on to the people around the city who'd pay €4 for it,
// before it melts in your bag (and it melts three times as fast in a hot car).
//
// The shop is a real grocery on the map (pois('shop'), by its parody name) 300–900 m from the start;
// its door is the pavement in front of it. The grannies (kinematic, elderly) crowd the door: "Prepáčte,
// prosím!" (the action key) squeezes through in 1.5 s, unless an elbow sends you back. At the counter
// every press is a block (€1.49, charged at once), ten a visit ("limit na osobu" — so, like the
// grannies, you go round again). The grannies buy too, so the stock runs out. Buyers stand around the
// city (💰, a couple of hundred metres to 750 m from the shop, later round the players), each wanting a
// few blocks at about €4; the sales are paid out when the round ends, with a bonus per block sold, so
// the round's money is capped like any other. With others it's one stock for everyone, and the best
// profit wins.
import { dist } from '../../../../util/math';
import { Ped } from '../../../../entities/Ped';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { SAY_BUMP, pickLine } from '../../../phrases';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';

/** the chains that put butter on sale (the map's parody names for them) */
export const GROCERS = ['Billka', 'Lidel', 'Tescó', 'Terno Plus', 'Jeme', 'Krajec', 'Kaufstrand', 'KOOP', 'Jednôtka', 'Freš'];
/** how far the shop is from where the round starts (m), and a wider ring when there's none in it */
const SHOP_R = [300, 900], SHOP_R_WIDE = [150, 1400];
/** the door (the nearest pavement) at most this far from the shop's point on the map (m) */
const DOOR_MAX = 35;
/** the stock: this many, and more for each player (one stock for everyone) */
const STOCK_BASE = 28, STOCK_PER = 12;
/** the sale price (cents), and how many a visit to the counter ("limit na osobu") */
export const PRICE = 149, LIMIT = 10;
/** at the door within this (m); at the counter while within this after getting past the grannies */
export const DOOR_R = 7, COUNTER_R = 9;
/** squeezing past the grannies takes this long (s); the chance of an elbow sending you back, by try
 *  (someone they've seen at the counter already gets the elbow more readily) */
export const SQUEEZE_S = 1.5;
const ELBOW = [0.3, 0.15], ELBOW_AGAIN = [0.5, 0.25];
/** grannies at the door, and how often one of them gets her butter and goes (s) */
const CROWD = 6, GRANNY_EVERY = [11, 16], GRANNY_SPEED = 1.2;
/** the bag warms up (0..1) in this long on foot in the sun (s); a block melts when it's full, and the
 *  rest are warm already: it starts again from here. A car, a tram and a scooter are worse; the shop's
 *  fridges are at the counter. */
export const HEAT_S = 90;
const HEAT_AFTER = 0.5, IN_CAR = 3, IN_TRAM = 2, ON_BIKE = 1.3;
/** buyers around the city: how many at once (and more with others), how far from the shop at first
 *  (a near pair and a far pair, m) and later from a player, how far apart; what they want, and what
 *  they pay (cents a block: the further out, the more), and how long they wait (s) */
const BUYERS = 4, BUYERS_MAX = 7, BUYER_BANDS = [[180, 350], [200, 450], [300, 600], [400, 750]], BUYER_R = [150, 600], BUYER_GAP = 150;
const WANT = [3, 5], OFFER = [380, 460], WAIT = [140, 220], NEXT_BUYER = [5, 11];
/** a buyer about to give up says so this long before (s) */
const BUYER_LEAVING = 20;
/** the action key reaches a buyer from this far (m) */
const REACH = 4;
/** the round (s) */
const DURATION = 240;
/** pay: the sales, and a bonus per block sold (€); with others, 1st–3rd get a bit more (in profit) */
export const BONUS = 8;
const PLACE_BONUS = [40, 20, 10];

/** "€1,49", "€15", "-€3,20" */
export function eur(cents: number): string {
  const c = Math.round(cents);
  const a = Math.abs(c);
  const s = a % 100 ? `€${Math.floor(a / 100)},${String(a % 100).padStart(2, '0')}` : `€${a / 100}`;
  return c < 0 ? `-${s}` : s;
}

/** 1 kocka, 2 kocky, 5 kociek */
function blocks(n: number) {
  return `${n} ${n === 1 ? 'kocka' : n >= 2 && n <= 4 ? 'kocky' : 'kociek'}`;
}

interface Shop {
  name: string;
  /** the shop's point on the map (inside its building) */
  sx: number;
  sy: number;
  /** the door: the pavement in front of it */
  x: number;
  y: number;
  /** from the door into the shop */
  ux: number;
  uy: number;
}

interface Granny {
  ped: Ped;
  /** her place in the crowd (index into `slots`) */
  slot: number;
  mode: 'crowd' | 'leave' | 'arrive';
  /** where she's walking to (leaving), and since when (sim.time) */
  tx: number;
  ty: number;
  t: number;
  /** stepped aside for someone squeezing through, until sim.time `until` */
  ax: number;
  ay: number;
  until: number;
}

interface Buyer {
  ped: Ped;
  x: number;
  y: number;
  want: number;
  /** cents a block */
  price: number;
  /** gives up and goes at this sim.time */
  until: number;
}

interface Player {
  /** good blocks in the bag */
  carried: number;
  /** how warm the bag is, 0..1 */
  heat: number;
  melted: number;
  sold: number;
  /** cents the buyers paid (paid out when the round ends) */
  revenue: number;
  /** blocks bought in all, and what that cost (whole euros: the till rounds the running total) */
  bought: number;
  spent: number;
  /** blocks bought at the counter this visit (the limit) */
  visit: number;
  /** past the grannies, at the counter */
  inside: boolean;
  /** squeezing through since sim.time (-1: not) */
  squeeze: number;
  /** squeezes tried at the door since the last time at the counter, and visits so far */
  tries: number;
  visits: number;
}

class Butter extends MiniGame {
  shop!: Shop;
  stock = 0;
  private stock0 = 0;
  private slots: { x: number; y: number }[] = [];
  private grannies: Granny[] = [];
  private buyers: Buyer[] = [];
  /** when the next buyers come (sim.time), one entry each */
  private nextBuyers: number[] = [];
  private grannyAt = 0;
  private soldOutTold = false;
  private state = new Map<number, Player>();

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = DURATION;
  }

  /** the sale: a grocery 300–900 m from (x, y) with a door on the pavement; false when there's none */
  pick(x: number, y: number): boolean {
    const w = this.sim.world;
    const shops: Shop[] = [];
    const find = (r: number[]) => {
      for (const s of w.pois('shop')) {
        const name = s.n ?? '';
        if (!GROCERS.includes(name)) continue;
        const d = dist(s.x, s.y, x, y);
        if (d < r[0] || d > r[1]) continue;
        const door = w.walkableNear(s.x, s.y);
        const dd = dist(door.x, door.y, s.x, s.y);
        if (dd > DOOR_MAX || w.spawnLevel(door.x, door.y, 0.5) !== 0 || w.inWater(door.x, door.y)) continue;
        const ux = dd > 1 ? (s.x - door.x) / dd : 1, uy = dd > 1 ? (s.y - door.y) / dd : 0;
        shops.push({ name, sx: s.x, sy: s.y, x: door.x, y: door.y, ux, uy });
      }
    };
    find(SHOP_R);
    if (!shops.length) find(SHOP_R_WIDE);
    if (!shops.length) return false;
    this.shop = shops[this.sim.rng.int(shops.length)];
    return true;
  }

  start() {
    const sim = this.sim, sh = this.shop;
    this.stock = this.stock0 = STOCK_BASE + STOCK_PER * this.players.length;
    for (const p of this.players) this.onJoin(p);
    // the crowd: a half ring round the door on the street side, two deep, each on a clear spot
    const w = sim.world;
    const ox = -sh.ux, oy = -sh.uy;
    for (const [r, deg] of [[1, -60], [1, -20], [1, 20], [1, 60], [1.9, -40], [1.9, 0], [1.9, 40]]) {
      const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const x = sh.x + sh.ux * 0.3 + (ox * c - oy * s) * r, y = sh.y + sh.uy * 0.3 + (ox * s + oy * c) * r;
      const at = w.clearSpot(x, y, 0.36);
      // (a spot pushed off a wall onto another one's is left out: nobody stands inside anybody)
      if (dist(at.x, at.y, x, y) <= 1.5 && !this.slots.some((q) => dist(q.x, q.y, at.x, at.y) < 0.65)) this.slots.push(at);
    }
    if (!this.slots.length) this.slots.push({ x: sh.x, y: sh.y });
    for (let i = 0; i < Math.min(CROWD, this.slots.length); i++) this.addGranny(i, this.slots[i].x, this.slots[i].y, 'crowd');
    this.grannyAt = sim.time + sim.rng.range(GRANNY_EVERY[0], GRANNY_EVERY[1]);
    const n = Math.min(BUYERS_MAX, BUYERS + this.players.length - 1);
    for (let i = 0; i < n; i++) if (!this.addBuyer(sh.x, sh.y, BUYER_BANDS[i % BUYER_BANDS.length])) this.nextBuyers.push(sim.time + 2);
    this.tell(`AKCIA! ${sh.name} má maslo za ${eur(PRICE)}. Kým sú zásoby!`, '#ffd54f', 3.5);
  }

  onJoin(p: SimPlayer) {
    if (!this.state.has(p.id))
      this.state.set(p.id, { carried: 0, heat: 0, melted: 0, sold: 0, revenue: 0, bought: 0, spent: 0, visit: 0, inside: false, squeeze: -1, tries: 0, visits: 0 });
  }

  onLeave(p: SimPlayer) {
    this.state.delete(p.id);
  }

  /** a player's state (tests) */
  of(p: SimPlayer): Player | undefined {
    return this.state.get(p.id);
  }

  // ------------------------------------------------------------------------------------ the step
  update(dt: number) {
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (s) this.stepPlayer(p, s, dt);
    }
    this.stepGrannies(dt);
    this.stepBuyers();
    if (this.stock <= 0 && !this.soldOutTold) {
      this.soldOutTold = true;
      this.tell('Vypredané! Rýchlejšie ako dubajská čokoláda.', '#ffd54f', 3);
    }
    // nothing more to do for anyone: the shelf is empty and nobody has butter left to sell
    if (this.stock <= 0 && this.players.every((p) => !this.state.get(p.id)?.carried)) this.finish();
  }

  private stepPlayer(p: SimPlayer, s: Player, dt: number) {
    const sh = this.shop, ped = p.ped;
    const onFoot = !ped.vehicle && !ped.aboard;
    const d = dist(ped.x, ped.y, sh.x, sh.y);
    // at the counter until they walk off (or drive off) with it
    if (s.inside && (!onFoot || d > COUNTER_R)) {
      s.inside = false;
      s.tries = 0;
    }
    if (s.squeeze >= 0) {
      if (!onFoot || d > DOOR_R) s.squeeze = -1;
      else if (this.sim.time - s.squeeze >= SQUEEZE_S) this.squeezed(p, s);
    }
    // the bag warms up (not at the counter: the fridges are right there)
    if (s.carried > 0) {
      const car = ped.vehicle;
      const k = s.inside ? 0 : car ? (car.spec.twoWheeler ? ON_BIKE : IN_CAR) : ped.aboard ? IN_TRAM : 1;
      s.heat += (k * dt) / HEAT_S;
      if (s.heat >= 1) {
        s.carried--;
        s.melted++;
        s.heat = s.carried > 0 ? HEAT_AFTER : 0;
        this.msg(p, car && !car.spec.twoWheeler ? '🫠 Kocka masla sa v aute roztopila!' : '🫠 Kocka masla sa roztopila!', '#ff8a80');
      }
    } else s.heat = 0;
  }

  /** squeezed past the grannies: at the counter, unless an elbow sends them back out */
  private squeezed(p: SimPlayer, s: Player) {
    s.squeeze = -1;
    const odds = (s.visits ? ELBOW_AGAIN : ELBOW)[s.tries] ?? 0;
    s.tries++;
    if (this.sim.rng.chance(odds)) {
      const g = this.nearestGranny(p.ped.x, p.ped.y);
      if (g) this.sim.events.say(g.ped.id, g.ped.x, g.ped.y, pickLine(SAY_BUMP, false, this.sim.rng.next()));
      this.msg(p, s.visits ? 'Babka: „Vy ste tu už boli!“ Loket do rebier.' : 'Babka: „Mladý, ja som tu bola prvá!“ Loket do rebier.', '#ff8a80', 3);
      return;
    }
    s.inside = true;
    s.visit = 0;
    s.visits++;
    this.msg(p, this.stock > 0 ? `Si pri pulte! Limit ${LIMIT} ks na osobu.` : 'Si pri pulte… a regál je prázdny.', '#69f0ae');
  }

  private nearestGranny(x: number, y: number): Granny | null {
    let best: Granny | null = null, bd = Infinity;
    for (const g of this.grannies) {
      const d = dist(g.ped.x, g.ped.y, x, y);
      if (g.mode === 'crowd' && !g.ped.dazed && d < bd) (bd = d), (best = g);
    }
    return best;
  }

  // ------------------------------------------------------------------------------- the grannies
  private addGranny(slot: number, x: number, y: number, mode: Granny['mode']) {
    const ped = this.spawnPed(elderly(this.sim, x, y));
    ped.state = 'idle';
    this.grannies.push({ ped, slot, mode, tx: x, ty: y, t: this.sim.time, ax: 0, ay: 0, until: 0 });
  }

  /** A spot a granny comes from or goes to: the pavement a dozen metres from the door. */
  private offstage(): { x: number; y: number } {
    const w = this.sim.world, sh = this.shop;
    const nodes = w.ped.nodesAround(sh.x, sh.y, 12, 20).filter((i) => !w.insideBuilding(w.ped.nx(i), w.ped.ny(i)) && !w.inWater(w.ped.nx(i), w.ped.ny(i)));
    if (nodes.length) {
      const i = nodes[this.sim.rng.int(nodes.length)];
      return { x: w.ped.nx(i), y: w.ped.ny(i) };
    }
    return w.clearSpot(sh.x - sh.ux * 14, sh.y - sh.uy * 14, 0.36);
  }

  private stepGrannies(dt: number) {
    const sim = this.sim, now = sim.time, sh = this.shop;
    // one of them has got hers: she goes (and the stock with her), and another one comes
    if (now >= this.grannyAt) {
      this.grannyAt = now + sim.rng.range(GRANNY_EVERY[0], GRANNY_EVERY[1]);
      const inCrowd = this.grannies.filter((g) => g.mode === 'crowd' && !g.ped.dazed);
      if (this.stock > 0 && inCrowd.length) {
        const g = inCrowd[sim.rng.int(inCrowd.length)];
        this.stock = Math.max(0, this.stock - (1 + sim.rng.int(2)));
        const to = this.offstage();
        Object.assign(g, { mode: 'leave', tx: to.x, ty: to.y, t: now });
        const from = this.offstage();
        this.addGranny(g.slot, from.x, from.y, 'arrive');
      }
    }
    for (const g of [...this.grannies]) {
      const ped = g.ped;
      if (ped.dazed) {
        // knocked down (a player's doing): she gets up by herself and heads home to change, and
        // another one takes her place
        this.grannies.splice(this.grannies.indexOf(g), 1);
        this.release(ped);
        if (g.mode !== 'leave') {
          const from = this.offstage();
          this.addGranny(g.slot, from.x, from.y, 'arrive');
        }
        continue;
      }
      let tx = g.tx, ty = g.ty;
      if (g.mode !== 'leave') {
        const sl = this.slots[g.slot] ?? this.slots[0];
        // jostling for the door, and out of the way for a moment when someone squeezes through
        const k = ped.seed % 97;
        tx = sl.x + Math.sin(now * 1.3 + k) * 0.12 + (now < g.until ? g.ax : 0);
        ty = sl.y + Math.cos(now * 1.1 + k) * 0.12 + (now < g.until ? g.ay : 0);
      }
      const dx = tx - ped.x, dy = ty - ped.y, d = Math.hypot(dx, dy);
      if (g.mode === 'leave' && (d < 0.6 || now - g.t > 25)) {
        this.drop(g);
        continue;
      }
      if (g.mode === 'arrive' && (d < 0.4 || now - g.t > 25)) {
        g.mode = 'crowd';
        if (d >= 0.4) (ped.x = tx), (ped.y = ty);
      }
      // (easing into their place, and a shuffle there)
      const sp = d > 0.03 ? Math.min(g.mode === 'crowd' ? 0.9 : GRANNY_SPEED, d * 3) : 0;
      ped.move(dt, sim.world, sp ? (dx / d) * sp : 0, sp ? (dy / d) * sp : 0);
      ped.state = sp > 0.2 ? 'walk' : 'idle';
      // in the crowd they face the door (and the butter behind it)
      if (g.mode === 'crowd' && sp < 0.3) ped.angle = Math.atan2(sh.sy - ped.y, sh.sx - ped.x);
    }
  }

  private drop(g: Granny) {
    this.grannies.splice(this.grannies.indexOf(g), 1);
    this.despawn(g.ped);
  }

  /** the grannies between `p` and the door step aside for a moment (they're not happy about it) */
  private makeWay(p: SimPlayer) {
    const sh = this.shop, now = this.sim.time;
    const px = p.ped.x, py = p.ped.y;
    const lx = sh.x - px, ly = sh.y - py, len = Math.hypot(lx, ly) || 1;
    const nx = -ly / len, ny = lx / len;
    let said = false;
    for (const g of this.grannies) {
      if (g.mode !== 'crowd' || g.ped.dazed) continue;
      // how far along the way in, and to which side of it
      const rx = g.ped.x - px, ry = g.ped.y - py;
      const along = (rx * lx + ry * ly) / len, side = rx * nx + ry * ny;
      if (along < -0.5 || along > len + 1 || Math.abs(side) > 1.4) continue;
      const k = side >= 0 ? 1 : -1;
      g.ax = nx * k * 0.75;
      g.ay = ny * k * 0.75;
      g.until = now + SQUEEZE_S + 2.5;
      if (!said) {
        said = true;
        this.sim.events.say(g.ped.id, g.ped.x, g.ped.y, pickLine(SAY_BUMP, false, this.sim.rng.next()));
      }
    }
  }

  // --------------------------------------------------------------------------------- the buyers
  /** A buyer somewhere `band` (m) from (cx, cy): on the pavement, apart from the others and not right
   *  next to a player. The further from the sale, the more they pay (they'd have paid €4.29 in the
   *  shop round the corner). False when no spot turned up this time (another try comes soon). */
  private addBuyer(cx: number, cy: number, band: number[]): boolean {
    const sim = this.sim, w = sim.world, sh = this.shop;
    for (let tries = 0; tries < 40; tries++) {
      const a = sim.rng.next() * Math.PI * 2, r = sim.rng.range(band[0], band[1]);
      const at = w.walkableNear(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      const d = dist(at.x, at.y, cx, cy), ds = dist(at.x, at.y, sh.x, sh.y);
      if (d < band[0] * 0.9 || d > band[1] * 1.1 || ds < BUYER_R[0] * 0.9) continue;
      if (w.spawnLevel(at.x, at.y, 0.5) !== 0 || w.inWater(at.x, at.y)) continue;
      if (this.buyers.some((b) => dist(b.x, b.y, at.x, at.y) < BUYER_GAP)) continue;
      if (this.players.some((p) => dist(this.pos(p).x, this.pos(p).y, at.x, at.y) < 60)) continue;
      const ped = this.spawnPed(new Ped('civ', at.x, at.y, sim.rng.seed()));
      // waving: over here, I'll take some
      ped.state = 'idle';
      ped.handsUp = true;
      ped.angle = Math.atan2(sh.y - at.y, sh.x - at.x);
      const far = Math.max(0, Math.min(1, (ds - BUYER_R[0]) / (BUYER_R[1] - BUYER_R[0])));
      const price = OFFER[0] + (OFFER[1] - OFFER[0]) * far + sim.rng.range(-20, 20);
      this.buyers.push({
        ped, x: at.x, y: at.y,
        want: WANT[0] + sim.rng.int(WANT[1] - WANT[0] + 1),
        price: Math.round(Math.max(OFFER[0], Math.min(OFFER[1], price)) / 10) * 10,
        until: sim.time + sim.rng.range(WAIT[0], WAIT[1]),
      });
      return true;
    }
    return false;
  }

  /** Buyers who got what they wanted (or tired of waiting) go; new ones turn up a while later, round
   *  one of the players (so there's always someone not too far). */
  private stepBuyers() {
    const sim = this.sim, now = sim.time;
    for (const b of [...this.buyers]) {
      if (b.want > 0 && now < b.until && !b.ped.dazed) continue;
      this.buyers.splice(this.buyers.indexOf(b), 1);
      // (someone knocked down gets up and heads home by themselves)
      if (b.ped.dazed) this.release(b.ped);
      else this.despawn(b.ped);
      this.nextBuyers.push(now + sim.rng.range(NEXT_BUYER[0], NEXT_BUYER[1]));
    }
    for (let i = this.nextBuyers.length - 1; i >= 0; i--) {
      if (now < this.nextBuyers[i]) continue;
      const p = this.players.length ? this.players[sim.rng.int(this.players.length)] : null;
      const at = p ? this.pos(p) : this.shop;
      if (this.addBuyer(at.x, at.y, BUYER_R)) this.nextBuyers.splice(i, 1);
      else this.nextBuyers[i] = now + 2;
    }
  }

  /** the buyer `p` is at (within reach), still wanting some */
  private buyerAt(p: SimPlayer): Buyer | null {
    let best: Buyer | null = null, bd = REACH;
    for (const b of this.buyers) {
      const d = dist(b.x, b.y, p.ped.x, p.ped.y);
      if (b.want > 0 && d <= bd) (bd = d), (best = b);
    }
    return best;
  }

  // ------------------------------------------------------------------------------ the action
  private atDoor(p: SimPlayer) {
    return !p.ped.vehicle && !p.ped.aboard && dist(p.ped.x, p.ped.y, this.shop.x, this.shop.y) <= DOOR_R;
  }

  private actionAt(p: SimPlayer, s: Player): string | undefined {
    if (p.ped.vehicle || p.ped.aboard) return undefined;
    if (s.inside) return this.stock > 0 && s.visit < LIMIT ? `Kúpiť maslo (${eur(PRICE)})` : undefined;
    const b = s.carried > 0 ? this.buyerAt(p) : null;
    if (b) return `Predať ${Math.min(b.want, s.carried)} ks (${eur(b.price)}/ks)`;
    if (this.atDoor(p) && this.stock > 0 && s.squeeze < 0) return 'Prepáčte, prosím!';
    return undefined;
  }

  act(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (!s) return;
    if (p.ped.vehicle || p.ped.aboard) return this.msg(p, 'Najprv vystúp.');
    if (s.inside) return this.buy(p, s);
    const b = s.carried > 0 ? this.buyerAt(p) : null;
    if (b) return this.sell(p, s, b);
    if (this.atDoor(p) && s.squeeze < 0) {
      if (this.stock <= 0) return this.msg(p, 'Vypredané. Babky odchádzajú s plnými taškami.', '#ffd54f');
      s.squeeze = this.sim.time;
      this.makeWay(p);
      this.msg(p, 'Prepáčte, prosím… pardon… prepáčte…', '#fff59d', SQUEEZE_S);
    }
  }

  /** one block off the shelf: charged at once, the till rounding the running total to whole euros */
  private buy(p: SimPlayer, s: Player) {
    if (this.stock <= 0) return this.msg(p, 'Vypredané! Babky boli rýchlejšie.', '#ff8a80');
    if (s.visit >= LIMIT) return this.msg(p, `Limit ${LIMIT} ks na osobu! Vyjdi von a postav sa znova.`, '#ffd740');
    const owe = Math.round(((s.bought + 1) * PRICE) / 100) - s.spent;
    if (p.profile.money < owe) return this.msg(p, 'Nemáš ani na maslo v akcii.', '#ff8a80');
    this.sim.addMoney(p, -owe);
    s.spent += owe;
    s.bought++;
    s.visit++;
    this.stock--;
    // a cold one from the fridge cools the rest a little
    s.heat = (s.heat * s.carried) / (s.carried + 1);
    s.carried++;
    this.addPoints(p, -PRICE / 100);
    if (s.visit === LIMIT) this.msg(p, 'Limit na osobu! Teraz to predaj kupcom (💰).', '#ffd740');
  }

  private sell(p: SimPlayer, s: Player, b: Buyer) {
    const n = Math.min(b.want, s.carried);
    s.carried -= n;
    s.sold += n;
    s.revenue += n * b.price;
    b.want -= n;
    if (!s.carried) s.heat = 0;
    this.addPoints(p, (n * b.price) / 100);
    this.pop(p, `+${eur(n * b.price)}`, b.x, b.y - 1.7);
    this.msg(p, `Predané: ${n} × ${eur(b.price)}. ${b.want ? 'Viac nemáš?' : 'Ďakujem, zlatko!'}`, '#69f0ae');
  }

  // ----------------------------------------------------------------------------- the outcome
  /** the profit so far (cents): the sales less what the butter cost */
  private profit(s: Player) {
    return s.revenue - s.spent * 100;
  }

  finish() {
    if (this.over) return;
    const group = this.round.started >= 2;
    const ranked = this.ranked();
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s) continue;
      const profit = this.profit(s);
      const place = ranked.indexOf(p) + 1;
      const bonus = BONUS * s.sold + (group && profit > 0 ? (PLACE_BONUS[place - 1] ?? 0) : 0);
      const pay = s.revenue / 100 + bonus;
      const text = s.sold
        ? `Predal si ${blocks(s.sold)} za ${eur(s.revenue)} (zisk ${eur(profit)}) + prémia ${eur(bonus * 100)}.`
        : s.bought
          ? s.melted
            ? 'Maslo sa ti roztopilo skôr, než si ho predal. 🫠'
            : 'Maslo si nepredal – aspoň budeš mať na chlieb.'
          : 'K maslu si sa ani nedostal. Babky vyhrali.';
      this.outcome(p, { pay, text });
    }
    super.finish();
  }

  // --------------------------------------------------------------------------------- the view
  view(p: SimPlayer): MiniView {
    const s = this.state.get(p.id);
    if (!s) return { goal: this.title };
    const sh = this.shop;
    const f = this.pos(p);
    const marks: MiniMark[] = [];
    const sold = this.stock <= 0;
    marks.push({ x: r1(sh.x), y: r1(sh.y), icon: '🧈', label: sold ? 'vypredané' : `${sh.name} · ${eur(PRICE)}`, color: '#ffd54f', r: DOOR_R, dim: sold ? 1 : undefined });
    let near = -1, nd = Infinity;
    for (const b of this.buyers) {
      if (b.want <= 0) continue;
      const d = dist(b.x, b.y, f.x, f.y);
      if (d < nd) (nd = d), (near = marks.length);
      const leaving = b.until - this.sim.time < BUYER_LEAVING;
      marks.push({ x: r1(b.x), y: r1(b.y), e: b.ped.id, icon: '💰', label: `${b.want}× ${eur(b.price)}${leaving ? ' · odchádza' : ''}`, color: leaving ? '#c5e1a5' : '#69f0ae', r: 2.5 });
    }
    // the way: to a buyer with butter in the bag (once done at the counter), else to the shop while
    // there's any left (none at the counter: that's where they are)
    const shopping = s.inside && !sold && s.visit < LIMIT;
    if (s.carried > 0 && near >= 0 && !shopping) marks[near].arrow = 1;
    else if (!sold && !s.inside) marks[0].arrow = 1;
    const car = p.ped.vehicle && !p.ped.vehicle.spec.twoWheeler;
    const goal = s.inside
      ? sold
        ? 'Regál je prázdny. Predaj, čo máš.'
        : s.visit < LIMIT
          ? `Kupuj! Limit ${LIMIT} ks na osobu.`
          : 'Limit vyčerpaný. Predaj maslo kupcom (💰) – alebo sa postav znova.'
      : s.carried > 0
        ? car
          ? 'V aute sa maslo topí trikrát rýchlejšie! Predaj ho (💰).'
          : 'Predaj maslo kupcom (💰), kým sa neroztopí!'
        : sold
          ? 'Vypredané – rýchlejšie ako dubajská čokoláda.'
          : this.atDoor(p)
            ? s.squeeze >= 0
              ? 'Pretláčaš sa pomedzi babky…'
              : 'Babky pri dverách! Pretlač sa k pultu.'
            : `AKCIA! ${sh.name} má maslo za ${eur(PRICE)}. Bež tam!`;
    const stats: [string, string][] = [['Maslo', `${s.carried} ks`], ['Sklad', sold ? '0' : `${this.stock}`], ['Zisk', eur(this.profit(s))]];
    if (s.inside) stats.splice(1, 0, ['Limit', `${s.visit}/${LIMIT}`]);
    const heat = Math.min(1, s.heat);
    return {
      goal,
      stats,
      bar: s.carried > 0 ? { label: 'Maslo sa topí', v: Math.round(heat * 100) / 100, color: heat > 0.8 ? '#ff5252' : heat > 0.5 ? '#ffb300' : '#ffe082' } : undefined,
      marks,
      act: this.actionAt(p, s),
    };
  }

  lobbyView(): MiniView {
    return { goal: 'Leták v appke: AKCIA! Maslo za €1,49. Babky už vyrážajú…' };
  }

  /** the stock when the round began (tests, the view) */
  get stockAtStart() {
    return this.stock0;
  }
}

/** A granny: an elderly figure, a headscarf if the seed gives one (her look comes from the seed, so
 *  every client draws the same granny). */
function elderly(sim: Sim, x: number, y: number): Ped {
  let fallback: Ped | null = null;
  for (let i = 0; i < 400; i++) {
    const p = new Ped('civ', x, y, sim.rng.seed());
    if (p.archetype !== 'elderly') continue;
    if (p.hairStyle === 'scarf') return p;
    fallback ??= p;
  }
  return fallback ?? new Ped('civ', x, y, sim.rng.seed());
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export const BUTTER_DEF: MiniGameDef = {
  kind: 'butter',
  lobby: 20,
  create(sim, round) {
    const g = new Butter(sim, round);
    return g.pick(round.x, round.y) ? g : 'Široko-ďaleko žiadny obchod s akciou – skús v meste.';
  },
};
