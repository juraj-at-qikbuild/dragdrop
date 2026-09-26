// Vlk courier / Hopík taxi: pick up food or a fare, drop it off somewhere realistic on the real map,
// don't crash, and get tipped for close calls along the way. Per-player state lives here (not on
// SimPlayer), the same way Revive.ts keeps its own progress map. Runs in both modes (offline and
// server) — it works solo, same as the plan asks. Plan: docs/plans/social-events.md
// ("Vlk courier / Hopík taxi"; "Implementation notes: Phase-0 contracts as built" wins where they differ).
//
// `JobState.stage` also allows 'offer', but this rule never sends it: an offer is generated the
// instant a job starts or chains (deterministic, no waiting on anything), so play only ever observes
// 'pickup' or 'deliver'. Between jobs (the 5 s/20 s chaining gap) there's nothing to show, so the
// client gets `s: null`, same as `stop()`.
import type { Sim } from '../../Sim';
import type { PlayerState, SimPlayer } from '../../SimPlayer';
import type { Vehicle } from '../../../entities/Vehicle';
import type { SimRule } from '../SimRule';
import type { JobKind, JobState } from '../types';
import { clamp, dist, formatMoney } from '../../../util/math';
import { offerCourier, roadMetres } from './courier';
import { offerDestination, offerFare, spawnBailingPed, spawnFare } from './taxi';

const CHAIN_GAP = 5; // s after a completed job before the next offer
const FAIL_GAP = 20; // s after a failed job (or one that couldn't be offered) before trying again
const STOP_TIME = 1; // s of continuous proximity + low speed to hand over an order / board a fare
const BASE_PAY: Record<JobKind, number> = { courier: 50, taxi: 30 };
const PER_METRE: Record<JobKind, number> = { courier: 0.06, taxi: 0.08 };
const SPEED_PER_S = 8; // m/s used for the timer: road length / this + 60 s
const TIMER_PAD = 60; // s
const MAX_TIME_BONUS = 0.5; // up to 50% of the base+distance pay, in proportion to time left
const TAXI_CAR_BONUS = 1.25; // a taxi-kind car earns 25% more
const CRASH_CONDITION = { courier: 25, taxi: 30 }; // points lost per crash (order condition / mood)
const CRASH_WINDOW = 0.5; // s: a health drop totalling >= the threshold within this window is a crash
const CRASH_HEALTH_FRAC = 0.03; // of spec.health
const TIP_VALUE = 5;
const TIP_CAP = 12; // tips per job
const TIP_MIN_SPEED = 8; // m/s: both the player's own speed and the relative speed to the other hull
const TIP_GAP = 1.2; // m: hull-to-hull gap under this, at speed, is "close"
const TIP_CONFIRM = 0.3; // s a near miss must stay crash-free before it's banked
const TIP_COOLDOWN = 1.5; // s per other vehicle/ped

interface CrashSample {
  t: number;
  dmg: number;
}

interface Job {
  kind: JobKind;
  /** > 0: waiting to chain the next offer at this sim.time; every field below is stale until then */
  waitUntil: number;
  stage: 'pickup' | 'deliver';
  /** where to go right now */
  x: number;
  y: number;
  label: string;
  /** courier's drop / taxi's destination: known from the start (it fixes the timer/pay), shown once
   *  the job reaches 'deliver' */
  next: { x: number; y: number; label: string };
  deadline: number; // sim.time it runs out
  totalTime: number; // deadline - the time the offer was made, for the time-bonus fraction
  routeM: number;
  condition: number; // the order's condition, or the passenger's mood: 0..100
  tips: number; // € paid out from near misses so far (JobState.pay/tips: "pay so far" during a job)
  tipCount: number;
  stopTimer: number;
  sendAcc: number; // seconds since the last periodic {k:'job'} update
  crashCar: Vehicle | null;
  crashBaseline: number;
  crashSamples: CrashSample[];
  pending: { otherId: number; age: number }[];
  lastTipAt: Map<number, number>;
  /** taxi only, while stage is 'pickup': the hailing ped's id (0 once boarded) */
  fareId: number;
}

const FAIL_TEXT: Record<JobKind, string> = {
  courier: 'Objednávka sa vyliala!',
  taxi: 'Zákazník vystúpil!',
};
const TIMEOUT_TEXT: Record<JobKind, string> = {
  courier: 'Nestihol si doručiť včas!',
  taxi: 'Zákazník sa nedočkal a odišiel!',
};
const INTERRUPT_TEXT: Record<JobKind, string> = {
  courier: 'Kuriér skončil v nemocnici, objednávka je preč!',
  taxi: 'Zákazník si počas jazdy našiel iný odvoz.',
};

export class Jobs implements SimRule {
  readonly id = 'jobs';
  private jobs = new Map<number, Job>();

  constructor(private sim: Sim) {}

  /** J with no job running: start a shift. A no-op if one is already active (the UI offers "stop"
   *  instead), if the player isn't playing, or — for a taxi — if they aren't in a car yet. */
  start(p: SimPlayer, kind: JobKind) {
    if ((kind !== 'courier' && kind !== 'taxi') || p.state !== 'play' || this.jobs.has(p.id)) return;
    const job: Job = {
      kind, waitUntil: 0, stage: 'pickup', x: 0, y: 0, label: '', next: { x: 0, y: 0, label: '' },
      deadline: 0, totalTime: 1, routeM: 0, condition: 100, tips: 0, tipCount: 0, stopTimer: 0, sendAcc: 0,
      crashCar: null, crashBaseline: 0, crashSamples: [], pending: [], lastTipAt: new Map(), fareId: 0,
    };
    this.jobs.set(p.id, job);
    this.beginOffer(p, job);
  }

  /** ends the shift outright, whether a job is running or the player is between offers */
  stop(p: SimPlayer) {
    const job = this.jobs.get(p.id);
    if (!job) return;
    this.despawnFare(job);
    this.jobs.delete(p.id);
    this.sim.events.toPlayer(p.id, { k: 'job', s: null });
  }

  onState(p: SimPlayer, _from: PlayerState, to: PlayerState) {
    if (to === 'play') return;
    const job = this.jobs.get(p.id);
    if (!job || job.waitUntil > 0) return; // nothing in flight to interrupt
    this.failJob(p, job, INTERRUPT_TEXT[job.kind]);
  }

  onRemove(p: SimPlayer) {
    const job = this.jobs.get(p.id);
    if (job) this.despawnFare(job);
    this.jobs.delete(p.id);
  }

  step(dt: number) {
    for (const [pid, job] of this.jobs) {
      const p = this.sim.players.get(pid);
      if (!p || p.state !== 'play') continue; // onState/onRemove already reacted; just wait out this tick
      if (job.waitUntil > 0) {
        if (this.sim.time >= job.waitUntil) this.beginOffer(p, job);
        continue;
      }
      this.tickActive(p, job, dt);
    }
  }

  // ------------------------------------------------------------------------------------- the shift
  private tickActive(p: SimPlayer, job: Job, dt: number) {
    if (job.deadline - this.sim.time <= 0) return this.failJob(p, job, TIMEOUT_TEXT[job.kind]);
    if (job.kind === 'taxi' && job.stage === 'pickup') {
      const fare = this.sim.pedById(job.fareId);
      if (!fare || fare.dead) return this.beginOffer(p, job); // died or despawned before pickup: re-offer
    }
    if (job.stage === 'deliver') {
      if (this.checkCrash(p, job)) {
        job.condition -= CRASH_CONDITION[job.kind];
        job.pending.length = 0; // any near miss still unconfirmed happened within the last 0.3 s: void it
        if (job.condition <= 0) return this.failJob(p, job, FAIL_TEXT[job.kind], job.kind === 'taxi');
        this.send(p, job); // a crash is worth showing right away, not up to 1 s later
      }
      this.checkNearMiss(p, job, dt);
    }
    if (this.checkStop(p, job, dt)) this.advance(p, job);
    job.sendAcc += dt;
    if (job.sendAcc >= 1) this.send(p, job);
  }

  /** Stop below the threshold speed, within range of the current target, held continuously for 1 s.
   *  Courier: 10 m / 2 m/s at both ends, on foot or in a car. Taxi: 6 m / 1 m/s to board (needs the
   *  car itself close and slow — it's a driving job); 10 m / 2 m/s to drop off, the generic "arrived"
   *  threshold (the plan doesn't specify one for taxi's drop-off, unlike its explicit boarding radius). */
  private checkStop(p: SimPlayer, job: Job, dt: number): boolean {
    const car = p.ped.vehicle;
    if (job.kind === 'taxi' && !car) {
      job.stopTimer = 0;
      return false;
    }
    const boarding = job.kind === 'taxi' && job.stage === 'pickup';
    const r = boarding ? 6 : 10, vMax = boarding ? 1 : 2;
    const fx = car ? car.x : p.ped.x, fy = car ? car.y : p.ped.y;
    const speed = car ? car.speed : Math.hypot(p.ped.vx, p.ped.vy);
    if (dist(fx, fy, job.x, job.y) <= r && speed < vMax) job.stopTimer += dt;
    else job.stopTimer = 0;
    if (job.stopTimer < STOP_TIME) return false;
    job.stopTimer = 0;
    return true;
  }

  /** the handover/boarding at the current target completed: move on to the second leg, or finish up */
  private advance(p: SimPlayer, job: Job) {
    if (job.stage === 'pickup') {
      if (job.kind === 'taxi') {
        // the fare boards and leaves the world, through Sim's own way of dropping a ped for good
        this.sim.peds = this.sim.peds.filter((q) => q.id !== job.fareId);
        job.fareId = 0;
      }
      job.stage = 'deliver';
      (job.x = job.next.x), (job.y = job.next.y), (job.label = job.next.label);
      // condition/mood and the crash/tip trackers only matter once carrying: start them fresh here
      job.condition = 100;
      job.crashCar = p.ped.vehicle;
      job.crashBaseline = job.crashCar?.health ?? 0;
      job.crashSamples = [];
      job.pending = [];
      this.send(p, job);
      return;
    }
    this.completeJob(p, job);
  }

  private completeJob(p: SimPlayer, job: Job) {
    const sim = this.sim;
    const subtotal = BASE_PAY[job.kind] + PER_METRE[job.kind] * job.routeM;
    const timeFrac = clamp((job.deadline - sim.time) / job.totalTime, 0, 1);
    const bonus = subtotal * MAX_TIME_BONUS * timeFrac;
    const car = p.ped.vehicle;
    const mult = job.kind === 'taxi' && car?.kind === 'taxi' ? TAXI_CAR_BONUS : 1;
    const pay = Math.round((subtotal + bonus) * mult);
    const stats = (p.profile.stats ??= {});
    const key = job.kind === 'courier' ? 'deliveries' : 'fares';
    stats[key] = (stats[key] ?? 0) + 1;
    sim.payout(p, pay, job.kind, job.x, job.y);
    const verb = job.kind === 'courier' ? 'Doručené!' : 'Odvezené!';
    sim.events.toPlayer(p.id, { k: 'msg', title: '', text: `${verb}  +${formatMoney(pay + job.tips)}`, time: 3, color: '#69f0ae' });
    this.chain(p, job, CHAIN_GAP);
  }

  private failJob(p: SimPlayer, job: Job, text: string, spawnFlee = false) {
    if (job.kind === 'taxi') {
      this.despawnFare(job);
      if (spawnFlee && p.ped.vehicle) spawnBailingPed(this.sim, p.ped.vehicle);
    }
    this.sim.events.toPlayer(p.id, { k: 'msg', title: '', text, time: 3, color: '#ff5252' });
    this.chain(p, job, FAIL_GAP);
  }

  /** end the current leg (if any) and wait `gap` seconds before the next offer; sends `null` right away */
  private chain(p: SimPlayer, job: Job, gap: number) {
    job.waitUntil = this.sim.time + gap;
    this.sim.events.toPlayer(p.id, { k: 'job', s: null });
  }

  /** Generate the next offer (job start, a chained job, or a re-offered taxi fare). Ends the shift
   *  outright when it can't — a taxi needing a car the player no longer has, or (in principle, on a
   *  very small/odd map) nowhere sensible to send them. */
  private beginOffer(p: SimPlayer, job: Job) {
    const sim = this.sim;
    job.waitUntil = 0;
    if (job.kind === 'taxi' && !p.ped.vehicle) return this.endShift(p, 'Na Hopík taxi potrebuješ auto — zmena končí.');
    let x: number, y: number, label: string, next: { x: number; y: number; label: string }, routeM: number, fareId = 0;
    if (job.kind === 'courier') {
      const offer = offerCourier(sim, p.ped.x, p.ped.y);
      if (!offer) return this.endShift(p, 'Momentálne nie je žiadna objednávka.');
      ({ x, y, label } = offer.pickup);
      next = offer.drop;
      routeM = offer.routeM;
    } else {
      const car = p.ped.vehicle!;
      const fare = offerFare(sim, car);
      const dest = fare && offerDestination(sim, fare.x, fare.y);
      if (!fare || !dest) return this.endShift(p, 'Nikto nechce Hopíka.');
      fareId = spawnFare(sim, fare.x, fare.y).id;
      (x = fare.x), (y = fare.y), (label = 'zákazník');
      next = dest;
      routeM = roadMetres(sim.world, fare.x, fare.y, dest.x, dest.y);
    }
    const totalTime = routeM / SPEED_PER_S + TIMER_PAD;
    job.stage = 'pickup';
    (job.x = x), (job.y = y), (job.label = label), (job.next = next);
    (job.routeM = routeM), (job.totalTime = totalTime), (job.deadline = sim.time + totalTime);
    (job.condition = 100), (job.tips = 0), (job.tipCount = 0), (job.stopTimer = 0), (job.fareId = fareId);
    (job.pending = []), (job.lastTipAt = new Map());
    (job.crashCar = null), (job.crashBaseline = 0), (job.crashSamples = []);
    this.send(p, job);
  }

  private endShift(p: SimPlayer, text: string) {
    this.despawnFare(this.jobs.get(p.id));
    this.jobs.delete(p.id);
    this.sim.events.toPlayer(p.id, { k: 'msg', title: '', text, time: 3, color: '#ffd740' });
    this.sim.events.toPlayer(p.id, { k: 'job', s: null });
  }

  private despawnFare(job?: Job) {
    if (!job?.fareId) return;
    this.sim.peds = this.sim.peds.filter((q) => q.id !== job.fareId);
    job.fareId = 0;
  }

  private send(p: SimPlayer, job: Job) {
    job.sendAcc = 0;
    const s: JobState = {
      kind: job.kind, stage: job.stage, x: job.x, y: job.y, label: job.label,
      left: Math.max(0, job.deadline - this.sim.time), condition: Math.max(0, job.condition), pay: job.tips, tips: job.tips,
    };
    this.sim.events.toPlayer(p.id, { k: 'job', s });
  }

  // -------------------------------------------------------------------------------- crash / near miss
  /** A crash: the car currently being driven lost >= 3% of its spec.health within the last 0.5 s.
   *  Tracked per job (not per car) so switching cars mid-job never falsely counts the swap itself, and
   *  reading `vehicle.health` works identically online (a kinematic, client-reported car) and offline. */
  private checkCrash(p: SimPlayer, job: Job): boolean {
    const car = p.ped.vehicle;
    if (car !== job.crashCar) {
      job.crashCar = car;
      job.crashBaseline = car?.health ?? 0;
      job.crashSamples = [];
      return false;
    }
    if (!car) return false;
    const lost = Math.max(0, job.crashBaseline - car.health);
    job.crashBaseline = car.health;
    if (lost > 0) job.crashSamples.push({ t: this.sim.time, dmg: lost });
    while (job.crashSamples.length && this.sim.time - job.crashSamples[0].t > CRASH_WINDOW) job.crashSamples.shift();
    let total = 0;
    for (const s of job.crashSamples) total += s.dmg;
    if (total < car.spec.health * CRASH_HEALTH_FRAC) return false;
    job.crashSamples = [];
    return true;
  }

  /** Near misses while carrying, above walking pace: queue a near miss the instant it happens, and pay
   *  it out — as a `style` "TESNE! +€5" — only once it's stayed crash-free for 0.3 s (checkCrash above
   *  voids every still-queued one the moment a crash lands). Capped at 12 tips/job, and at most one
   *  queued per other hull every 1.5 s so grazing past the same car for a whole second doesn't pay 20
   *  times over. */
  private checkNearMiss(p: SimPlayer, job: Job, dt: number) {
    const car = p.ped.vehicle;
    if (car && car.speed > TIP_MIN_SPEED) {
      const r = car.spec.width / 2 + TIP_GAP + 3; // a little slack around the real query radius
      this.sim.forVehiclesNear(car.x, car.y, r, (v) => {
        if (v !== car && !v.wrecked) this.tryNearMiss(job, car, v.id, v.x, v.y, v.spec.width / 2, v.vx, v.vy);
      });
      this.sim.forPedsNear(car.x, car.y, r, (q) => {
        if (!q.dead && !q.vehicle) this.tryNearMiss(job, car, q.id, q.x, q.y, q.r, q.vx, q.vy);
      });
    }
    for (let i = job.pending.length - 1; i >= 0; i--) {
      const pend = job.pending[i];
      pend.age += dt;
      if (pend.age < TIP_CONFIRM) continue;
      job.pending.splice(i, 1);
      if (job.tipCount >= TIP_CAP) continue;
      job.tipCount++;
      job.tips += TIP_VALUE;
      // `car` may have gone (exited/ejected) since this near miss was queued: fall back to the figure
      const fx = car ? car.x : p.ped.x, fy = car ? car.y : p.ped.y;
      this.sim.payout(p, TIP_VALUE, 'tip', fx, fy); // paid now, not bundled into the final delivery/fare payout
      this.sim.events.toPlayer(p.id, { k: 'style', label: `TESNE! +${formatMoney(TIP_VALUE)}`, cash: 0, x: fx, y: fy - 1.7 });
    }
  }

  private tryNearMiss(job: Job, car: Vehicle, otherId: number, ox: number, oy: number, otherHalf: number, ovx: number, ovy: number) {
    const gap = dist(car.x, car.y, ox, oy) - car.spec.width / 2 - otherHalf;
    if (gap < 0 || gap > TIP_GAP) return;
    if (Math.hypot(car.vx - ovx, car.vy - ovy) <= TIP_MIN_SPEED) return;
    const last = job.lastTipAt.get(otherId) ?? -Infinity;
    if (this.sim.time - last < TIP_COOLDOWN) return;
    job.lastTipAt.set(otherId, this.sim.time);
    job.pending.push({ otherId, age: 0 });
  }
}
