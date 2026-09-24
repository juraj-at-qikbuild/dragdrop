import type { Game } from '../game/Game';
import { Vehicle } from '../entities/Vehicle';
import { dist, formatMoney } from '../util/math';

type Stage =
  | { t: 'goto'; x: number; y: number; r: number; text: string; car?: boolean; stop?: boolean; onFoot?: boolean; missionCar?: boolean }
  | { t: 'anyCar'; text: string }
  | { t: 'enterCar'; text: string }
  | { t: 'wanted'; level: number }
  | { t: 'lose'; text: string }
  | { t: 'survive'; secs: number; level: number; text: string }
  | { t: 'say'; text: string };

export interface MissionDef {
  id: string;
  title: string;
  giver: string; // landmark id where the phone booth stands
  intro: string;
  reward: number;
  timeLimit?: number;
  requires?: string[];
  build: (g: Game, m: MissionManager) => Stage[];
}

const nodeNear = (g: Game, id: string, graph: 'car' | 'ped' = 'car') => {
  const l = g.world.landmark(id);
  const gr = g.world[graph];
  const n = gr.nearest(l.x, l.y, 400);
  return n >= 0 ? { x: gr.nx(n), y: gr.ny(n) } : { x: l.x, y: l.y };
};

/** Points along the Danube embankment, east to west, from real street geometry. */
function embankment(g: Game) {
  const names = new Set(['Rázusovo nábrežie', 'Vajanského nábrežie', 'Fajnorovo nábrežie', 'Nábrežie arm. gen. Ludvíka Svobodu', 'Nábrežie armádneho generála Ľudvíka Slobodu', 'Dvořákovo nábrežie']);
  const pts: { x: number; y: number }[] = [];
  for (const e of g.world.car.edges) {
    if (e.name < 0 || !names.has(g.world.names[e.name])) continue;
    for (let i = 0; i < e.p.length; i += 2) pts.push({ x: e.p[i], y: e.p[i + 1] });
  }
  pts.sort((a, b) => b.x - a.x);
  const out: { x: number; y: number }[] = [];
  for (const p of pts) if (!out.length || dist(p.x, p.y, out[out.length - 1].x, out[out.length - 1].y) > 230) out.push(p);
  return out.slice(0, 8);
}

export const MISSIONS: MissionDef[] = [
  {
    id: 'taxi',
    title: 'Turista z Hradu',
    giver: 'main',
    intro: 'Fero z Hlavného: "Nemecký turista čaká pri Hrade a chce na Euroveu. Zožeň auto a zarob niečo!"',
    reward: 600,
    timeLimit: 210,
    build: (g) => {
      const castle = nodeNear(g, 'castle');
      const eurovea = nodeNear(g, 'eurovea');
      return [
        { t: 'anyCar', text: 'Zožeň si auto.' },
        { t: 'goto', ...castle, r: 9, car: true, stop: true, text: 'Choď po turistu k Bratislavskému hradu.' },
        { t: 'say', text: 'Turista: "Guten Tag! Schnell, bitte, zur Eurovea!"' },
        { t: 'goto', ...eurovea, r: 10, car: true, stop: true, text: 'Odvez turistu na Euroveu.' },
      ];
    },
  },
  {
    id: 'kofola',
    title: 'Kofolka pre UFO',
    giver: 'market',
    intro: 'Janka zo Starej tržnice: "V UFE im došla Kofolka! Zober našu dodávku a nerozbi ju."',
    reward: 800,
    timeLimit: 240,
    build: (g, m) => {
      const start = nodeNear(g, 'market');
      const ufo = nodeNear(g, 'snp');
      const link = g.world.car.out[g.world.car.nearest(start.x, start.y)]?.[0];
      let sx = start.x + 4, sy = start.y, sa = 0;
      if (link) {
        sx = link.edge.p[0];
        sy = link.edge.p[1];
        sa = Math.atan2(link.edge.p[3] - link.edge.p[1], link.edge.p[2] - link.edge.p[0]);
      }
      const van = new Vehicle('van', sx, sy, sa, '#c8102e');
      m.addVehicle(van);
      return [
        { t: 'enterCar', text: 'Nasadni do dodávky Kofolka.' },
        { t: 'goto', ...ufo, r: 12, car: true, missionCar: true, stop: true, text: 'Doruč Kofolku k Mostu SNP (UFO) v Petržalke.' },
      ];
    },
  },
  {
    id: 'michael',
    title: 'Útek od Michalskej brány',
    giver: 'michael',
    intro: 'Hlas v telefóne: "Zlatníctvo pri Michalskej bráne má otvorený trezor. Zober to a zmizni."',
    reward: 1200,
    build: (g) => {
      const shop = nodeNear(g, 'primate', 'ped');
      return [
        { t: 'goto', ...shop, r: 3, onFoot: true, text: 'Choď pešo do zlatníctva pri Primaciálnom paláci.' },
        { t: 'wanted', level: 3 },
        { t: 'lose', text: 'Alarm! Strať políciu.' },
      ];
    },
  },
  {
    id: 'race',
    title: 'Nábrežné preteky',
    giver: 'hviezdoslav',
    intro: 'Pretekár Maťo: "Nábrežie od Starého mosta až pod Hrad. Stihneš to? Stávka je tisíc."',
    reward: 1200,
    build: (g) => {
      const cps = embankment(g);
      const stages: Stage[] = [{ t: 'anyCar', text: 'Zožeň rýchle auto.' }];
      if (cps.length) stages.push({ t: 'goto', ...cps[0], r: 10, car: true, text: 'Choď na štart pretekov pri Starom moste.' });
      stages.push({ t: 'say', text: '3... 2... 1... ŠTART!' });
      cps.slice(1).forEach((p, i) => stages.push({ t: 'goto', ...p, r: 12, car: true, text: `Kontrolný bod ${i + 1}/${cps.length - 1}` }));
      return stages;
    },
  },
  {
    id: 'steal',
    title: 'Škodovka pre Petržalku',
    giver: 'kamenne',
    intro: 'Dílerka Zuzka: "Pri Modrom kostolíku parkuje modrá Octávka. Dovez mi ju do garáže pri Auparku. Celú!"',
    reward: 1500,
    timeLimit: 300,
    build: (g, m) => {
      const spot = nodeNear(g, 'blue');
      const garage = nodeNear(g, 'aupark');
      const link = g.world.car.out[g.world.car.nearest(spot.x, spot.y)]?.[0];
      let a = 0, x = spot.x, y = spot.y;
      if (link) {
        const p = link.edge.p;
        a = Math.atan2(p[3] - p[1], p[2] - p[0]);
        x = p[0] + (p[2] - p[0]) * 0.5 - Math.sin(a) * (link.edge.width / 2 - 1.1);
        y = p[1] + (p[3] - p[1]) * 0.5 + Math.cos(a) * (link.edge.width / 2 - 1.1);
      }
      const car = new Vehicle('sedan', x, y, a, '#1565c0');
      car.parked = true;
      m.addVehicle(car);
      return [
        { t: 'enterCar', text: 'Ukradni modrú Octávku pri Modrom kostolíku.' },
        { t: 'wanted', level: 1 },
        { t: 'goto', ...garage, r: 10, car: true, missionCar: true, stop: true, text: 'Dovez auto do garáže pri Auparku v Petržalke.' },
      ];
    },
  },
  {
    id: 'finale',
    title: 'Pán Bratislavy',
    giver: 'castle',
    intro: 'Neznámy: "Celá Blava o tebe hovorí. Prežij hon celej polície a stretneme sa v Sade Janka Kráľa."',
    reward: 5000,
    requires: ['taxi', 'kofola', 'michael', 'race', 'steal'],
    build: (g) => {
      const park = nodeNear(g, 'sad', 'ped');
      return [
        { t: 'survive', secs: 60, level: 4, text: 'Prežij 60 sekúnd s políciou v pätách!' },
        { t: 'goto', ...park, r: 6, text: 'Choď do Sadu Janka Kráľa v Petržalke.' },
        { t: 'lose', text: 'Strať políciu.' },
      ];
    },
  },
];

export class MissionManager {
  active: MissionDef | null = null;
  stages: Stage[] = [];
  stage = 0;
  timeLeft = 0;
  stageTimer = 0;
  vehicles: Vehicle[] = [];
  booths: { def: MissionDef; x: number; y: number }[] = [];
  cooldown = 0;

  constructor(private g: Game) {
    for (const def of MISSIONS) {
      const l = g.world.landmark(def.giver);
      const p = g.world.walkableNear(l.x, l.y);
      this.booths.push({ def, x: p.x, y: p.y });
    }
  }

  available() {
    return this.booths.filter((b) => !this.g.save.done.includes(b.def.id) && (b.def.requires ?? []).every((r) => this.g.save.done.includes(r)));
  }

  addVehicle(v: Vehicle) {
    v.mission = true;
    this.vehicles.push(v);
    this.g.vehicles.push(v);
  }

  get current(): Stage | null {
    return this.active ? this.stages[this.stage] ?? null : null;
  }

  /** Objective marker for HUD / minimap. */
  target(): { x: number; y: number } | null {
    const s = this.current;
    if (!s) return null;
    if (s.t === 'goto') return s;
    if (s.t === 'enterCar' && this.vehicles[0]) return this.vehicles[0];
    return null;
  }

  text(): string {
    const s = this.current;
    return s && 'text' in s ? s.text : '';
  }

  start(def: MissionDef) {
    this.active = def;
    this.stage = 0;
    this.stageTimer = 0;
    this.stages = def.build(this.g, this);
    this.timeLeft = def.timeLimit ?? 0;
    this.g.message(def.title, def.intro, 6);
    this.g.audio.jingle(true);
  }

  fail(reason: string) {
    if (!this.active) return;
    this.g.message('MISIA ZLYHALA', reason, 4, '#ff5252');
    this.g.audio.jingle(false);
    this.cleanup();
  }

  private pass() {
    const def = this.active!;
    this.g.addMoney(def.reward);
    this.g.save.done.push(def.id);
    this.g.persist();
    this.g.message('MISIA SPLNENÁ!', `${def.title}  +${formatMoney(def.reward)}`, 5, '#69f0ae');
    this.g.audio.jingle(true);
    this.cleanup();
    if (def.id === 'finale') this.g.message('KONIEC', 'Si pánom Bratislavy! Mesto je tvoje – jazdi ďalej.', 8, '#ffd740');
  }

  private cleanup() {
    for (const v of this.vehicles) v.mission = false;
    this.vehicles = [];
    this.active = null;
    this.stages = [];
    this.cooldown = 3;
  }

  update(dt: number) {
    const g = this.g;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (!this.active) {
      if (g.player.vehicle || g.state !== 'play' || this.cooldown > 0) return;
      for (const b of this.available()) if (dist(b.x, b.y, g.player.x, g.player.y) < 2.2) return this.start(b.def);
      return;
    }
    if (this.timeLeft > 0) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) return this.fail('Vypršal čas.');
    }
    for (const v of this.vehicles) if (v.wrecked || v.sinking) return this.fail('Auto je zničené.');
    const s = this.current;
    if (!s) return this.pass();
    this.stageTimer += dt;
    const car = g.player.vehicle;
    const next = () => {
      this.stage++;
      this.stageTimer = 0;
      g.audio.pickup();
    };
    switch (s.t) {
      case 'anyCar':
        if (car) next();
        break;
      case 'enterCar':
        if (car && car === this.vehicles[0]) next();
        break;
      case 'goto': {
        const px = car ? car.x : g.player.x, py = car ? car.y : g.player.y;
        if (dist(px, py, s.x, s.y) > s.r) break;
        if (s.car && !car) break;
        if (s.onFoot && car) break;
        if (s.missionCar && car !== this.vehicles[0]) break;
        if (s.stop && car && car.speed > 2.5) break;
        next();
        break;
      }
      case 'wanted':
        g.wanted = Math.max(g.wanted, s.level);
        next();
        break;
      case 'lose':
        if (g.wanted <= 0) next();
        break;
      case 'survive':
        g.wanted = Math.max(g.wanted, s.level);
        if (this.stageTimer >= s.secs) next();
        break;
      case 'say':
        g.message('', s.text, 2.5);
        next();
        break;
    }
    if (this.active && this.stage >= this.stages.length) this.pass();
  }

  /** reset when player dies / is busted */
  onPlayerDown() {
    if (this.active) this.fail(this.g.state === 'busted' ? 'Zatkli ťa.' : 'Zomrel si.');
  }

  drawWorld(ctx: CanvasRenderingContext2D, time: number) {
    // phone booths
    if (!this.active)
      for (const b of this.available()) {
        const pulse = 1 + Math.sin(time * 4) * 0.15;
        ctx.fillStyle = 'rgba(255, 214, 0, 0.25)';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 2.2 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1e5aa8';
        ctx.fillRect(b.x - 0.5, b.y - 0.5, 1, 1);
        ctx.fillStyle = '#ffd600';
        ctx.fillRect(b.x - 0.3, b.y - 0.3, 0.6, 0.25);
      }
    const t = this.target();
    const s = this.current;
    if (t && s?.t === 'goto') {
      const pulse = 1 + Math.sin(time * 5) * 0.1;
      ctx.strokeStyle = 'rgba(255, 214, 0, 0.9)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([1.5, 1]);
      ctx.beginPath();
      ctx.arc(t.x, t.y, s.r * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 214, 0, 0.18)';
      ctx.fill();
    }
  }
}
