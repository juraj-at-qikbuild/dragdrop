import type { Game } from '../game/Game';
import { WEAPONS } from '../shared/sim/Combat';
import { SWIM_S } from '../shared/sim/Sim';
import type { WeaponId } from '../shared/entities/Ped';
import { formatMoney, formatPoints } from '../shared/util/math';
import type { LiveState } from '../game/SimHost';
import { liveForecast } from '../game/features/activities/forecast';
import { activitiesSeen } from '../game/features/activities/seen';
import { chipLine } from '../game/features/activities/text';
import { edgePoint, inPlay, type HudLayout, type Rect } from './layout';
import type { PoliceUi } from '../game/features/PoliceUi';
import { isModalOpen } from './kit/dom';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
const BODY = `'Inter', system-ui, sans-serif`;
const GOLD = '#ffd600';

interface HitIndicator {
  angle: number;
  age: number;
}

/** optional fields other systems may set on Game/Vehicle; read defensively so this file
 *  never has to wait on those systems' ownership. */
interface ComboState { mult: number; timer: number; label: string }

export class Hud {
  hurt = 0;
  flashStars = 0;
  /** true while the police are actively hunting for the player (no line of sight yet): flashes the stars */
  searching = false;
  private shownMoney = 0;
  /** today's leaderboard points as shown (they count up like the money), and a glow when they grow */
  private shownPoints = 0;
  private lastPoints = 0;
  private pointsFlash = 0;
  private starPulse = 0;
  private hits: HitIndicator[] = [];
  /** where the Aktivity chip was drawn this frame (the touch screen's tap target), null when hidden */
  activitiesRect: Rect | null = null;

  constructor(private g: Game) {
    this.shownMoney = g.save.money;
  }

  /** a blue directional arc at the screen edge, pointing toward where the water came from; call with the world-space angle from the player. */
  hitFrom(angle: number) {
    this.hits.push({ angle, age: 0 });
    if (this.hits.length > 6) this.hits.shift();
  }

  draw(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const W = g.viewW, H = g.viewH;
    const L = g.layout;
    const small = L.small;
    const dt = 1 / 60;
    if (L.stack) g.stackY = L.stack.y;
    if (this.hurt > 0) {
      // a splash of water over the screen (docs/plans/non-violent.md: getting hit is getting wet)
      ctx.fillStyle = `rgba(40,140,230,${this.hurt * 0.45})`;
      ctx.fillRect(0, 0, W, H);
      this.hurt -= dt;
    }
    this.shownMoney += (g.save.money - this.shownMoney) * 0.15;
    if (Math.abs(g.save.money - this.shownMoney) < 1) this.shownMoney = g.save.money;
    if (this.flashStars > 0) this.flashStars -= dt, (this.starPulse = 1);
    else this.starPulse = Math.max(0, this.starPulse - dt * 2);

    this.drawHitIndicators(ctx, W, H, dt);
    this.drawTouchAim(ctx);

    // the top-right panel: `right` and `top` stand where the screen edge and padding used to
    const right = L.panel.right, top = L.panel.y;
    const topW = L.panel.w;
    let topH = small ? 74 : 92;
    const car = g.player.vehicle;
    const armor = g.player.armor;
    if (armor > 0) topH += small ? 12 : 14;
    // swimming (docs/plans/gameplay.md, Phase 3): the breath left
    const swim = g.swimT > 0;
    if (swim) topH += small ? 12 : 14;
    panel(ctx, right - topW, top, topW, topH);

    // money
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${small ? 22 : 28}px ${HEAD}`;
    glowText(ctx, formatMoney(this.shownMoney), right - 10, top + 6, '#8bdc6b', 'rgba(139,220,107,0.5)');

    // wanted stars
    const stars = Math.ceil(g.wanted - 0.001);
    const sy = top + (small ? 30 : 38);
    const flash = (this.flashStars > 0 || this.searching) && Math.floor(g.time * 8) % 2 === 0;
    for (let i = 0; i < 5; i++) {
      const x = right - 20 - (4 - i) * (small ? 20 : 25);
      const on = i < stars;
      const scale = on ? 1 + this.starPulse * 0.35 * (1 - i / 5) : 1;
      drawStar(ctx, x, sy + 10, (small ? 8 : 11) * scale, on ? (flash ? '#fff' : GOLD) : 'rgba(255,255,255,0.14)', on);
    }

    // clock + weather glyph
    const cy = sy + (small ? 24 : 30);
    this.drawClock(ctx, right - 10, cy, small);

    // health + armour
    const hy = cy + (small ? 18 : 22);
    const bw = topW - 20;
    const bx = right - 10 - bw;
    let by = hy;
    drawBar(ctx, bx, by, bw, 9, Math.max(0, g.player.health / 100), g.player.health > 30 ? '#e53935' : Math.floor(g.time * 4) % 2 ? '#ff8a80' : '#b71c1c', 'rgba(0,0,0,0.5)', '❤', small);
    by += 13;
    if (armor > 0) {
      drawBar(ctx, bx, by, bw, 7, Math.max(0, armor / 100), '#90caf9', 'rgba(0,0,0,0.5)', '🛡', small);
      by += 11;
    }
    if (swim) {
      const left = Math.max(0, 1 - g.swimT / SWIM_S);
      drawBar(ctx, bx, by, bw, 7, left, left > 0.3 || Math.floor(g.time * 4) % 2 ? '#4fc3f7' : '#01579b', 'rgba(0,0,0,0.5)', '🫧', small);
      by += 11;
    }

    // weapon panel (bottom-left of the top panel)
    this.drawWeaponPanel(ctx, right - topW + 8, top + topH - (small ? 20 : 24), small);

    // under the top panel: online the connection badge and today's points (drawNet, drawn last), then
    // the Aktivity chip (on a touch screen at the top of the feature stack instead), then the combo
    // meter, if the combat system is driving one
    const gap = small ? 6 : 8;
    const netH = g.online ? (small ? 18 : 22) + gap : 0;
    let colY = top + topH + gap + (g.online ? this.netHeight(small) + gap : 0);
    this.activitiesRect = this.drawActivities(ctx, small, (w, h) => {
      const spot = g.stackSpot(h);
      return spot ?? { x: right - w, y: colY };
    });
    if (!L.touch) colY += this.activitiesRect.h + gap;
    // what the police know, while wanted (PoliceUi): under the stars' column, or in the touch stack
    const police = g.features.find((f) => f.id === 'police') as PoliceUi | undefined;
    const chip = police?.drawChip(ctx, small, (w, h) => g.stackSpot(h) ?? { x: right - w, y: colY });
    if (chip && !L.touch) colY += chip.h + gap;
    const combo = (g as unknown as { combo?: ComboState }).combo;
    if (combo && combo.mult > 1 && combo.timer > 0) this.drawCombo(ctx, combo, right - topW + 8, L.touch ? top + topH + gap + netH + 8 : colY + (small ? 8 : 10), small);

    // speedometer (only while driving)
    if (car) this.drawSpeedo(ctx, L.speedo.cx, L.speedo.cy, L.speedo.r, car, small);

    // minimap
    g.mapView.drawMini(ctx, L.mini.cx, L.mini.cy, L.mini.r);

    // what the player can do right here (above the speedometer when driving), and the pad's buttons.
    // On a touch screen the use button itself says what it does (TouchControls), so only hints here.
    const promptY = car ? L.prompt.car : L.prompt.foot;
    const pr = g.prompt();
    if (pr && !(L.touch && pr.use && !g.input.pad.active)) this.drawPrompt(ctx, pr.use, pr.text, L.prompt.cx, promptY, small, L.prompt.w);
    // a panel open over the game (a shop…): what the pad does there (Game.padModal)
    if (isModalOpen() && g.input.pad.active) this.drawPadLegend(ctx, L.prompt.cx, promptY - (small ? 34 : 42), PAD_MENU, 1, small);
    else if (g.padHints > 0) this.drawPadLegend(ctx, L.prompt.cx, promptY - (small ? 34 : 42), car ? (car.spec.twoWheeler ? PAD_BIKE : PAD_CAR) : PAD_FOOT, Math.min(1, g.padHints), small);

    // street and district name
    ctx.textAlign = L.place.align;
    ctx.textBaseline = 'bottom';
    if (g.street.timer > 0 && g.street.name) {
      ctx.globalAlpha = Math.min(1, g.street.timer);
      ctx.font = `600 ${small ? 15 : 20}px ${HEAD}`;
      outlined(ctx, g.street.name, L.place.x, L.place.y - L.place.lineH, '#fff');
      ctx.globalAlpha = 1;
    }
    ctx.font = `600 ${small ? 11 : 13}px ${BODY}`;
    shadowed(ctx, g.quarter ? `${g.quarter} · ${g.district}` : `${g.district} · Bratislava`, L.place.x, L.place.y, '#cfd8dc');

    // mission objective banner
    const m = g.missions;
    if (m.active) {
      const t = m.text();
      if (t) this.drawObjective(ctx, t, L);
      if (m.timeLeft > 0) {
        ctx.textAlign = 'center';
        ctx.font = `700 ${small ? 20 : 26}px ${HEAD}`;
        const s = Math.ceil(m.timeLeft);
        outlined(ctx, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, L.band.cx, L.objective.timerY, s < 20 ? '#ff5252' : '#fff');
      }
      const tgt = m.target();
      if (tgt) this.drawArrow(ctx, tgt.x, tgt.y);
    }
    // the waypoint set on the city map
    const wp = g.gps.waypoint;
    if (wp && !(m.active && m.target())) this.drawArrow(ctx, wp.x, wp.y, '#b388ff');

    // messages (one at a time)
    const msg = g.messages[0];
    if (msg) {
      const a = Math.min(1, msg.time * 2);
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let y = L.msgY;
      if (msg.title) {
        ctx.font = `700 ${small ? 24 : 36}px ${HEAD}`;
        outlined(ctx, msg.title, W / 2, y, msg.color);
        y += small ? 30 : 40;
      }
      ctx.font = `700 ${small ? 14 : 18}px ${BODY}`;
      // on a phone at most two lines, so a long message doesn't cover the player
      wrapOutlined(ctx, msg.text, W / 2, y, Math.min(W * 0.8, 680), small ? 18 : 24, '#fff', false, L.touch ? 2 : 0);
      ctx.globalAlpha = 1;
    }

    // radio
    if (g.radioText.time > 0) {
      ctx.globalAlpha = Math.min(1, g.radioText.time);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = `700 ${small ? 12 : 15}px ${BODY}`;
      wrapOutlined(ctx, g.radioText.text, L.prompt.cx, L.radio.y, L.radio.w, 20, '#f8bbd0', true, L.touch ? 2 : 0);
      ctx.globalAlpha = 1;
    }

    // wasted / busted (downed has its own HUD: ReviveUi's vignette + "Krvácaš" + give-up prompt)
    if (g.state !== 'play' && g.state !== 'downed') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${small ? 44 : 84}px ${HEAD}`;
      outlined(ctx, g.state === 'busted' ? 'ZATKNUTÝ' : 'ZOŠROTOVANÝ', W / 2, H / 2, g.state === 'busted' ? '#448aff' : '#ff1744', 6);
    }
    if (g.online) this.drawNet(ctx, right, top + topH + (small ? 6 : 8), small);
    if (g.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  /** "[F] Nastúpiť": the use button as the player's input shows it (a key cap, the pad's Y, the
   *  touch 🚗) and what it does here; without the button, a plain hint */
  private drawPrompt(ctx: CanvasRenderingContext2D, use: boolean, text: string, cx: number, cy: number, small: boolean, maxW = Infinity) {
    const g = this.g;
    ctx.save();
    // a long hint shrinks to fit between the thumbs (down to 10 px)
    let fs = small ? 13 : 16;
    ctx.font = `700 ${fs}px ${BODY}`;
    while (fs > 10 && ctx.measureText(text).width + (use ? 50 : 18) > maxW) ctx.font = `700 ${--fs}px ${BODY}`;
    ctx.textBaseline = 'middle';
    const h = small ? 28 : 34, gw = use ? h - 6 : 0, tw = ctx.measureText(text).width;
    const w = tw + gw + (use ? 22 : 18);
    const x = cx - w / 2, y = cy - h / 2;
    // pulse gently so it catches the eye
    const pulse = 0.5 + 0.5 * Math.sin(g.time * 4);
    ctx.fillStyle = 'rgba(10,12,18,0.72)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = use ? `rgba(255,214,0,${0.45 + pulse * 0.4})` : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (use) buttonGlyph(ctx, g.input.pad.active ? 'Y' : g.touch ? '🚗' : 'F', x + 4 + gw / 2, cy, gw / 2, g.input.pad.active ? 'pad' : g.touch ? 'touch' : 'key');
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + (use ? gw + 12 : 9), cy + 1);
    ctx.restore();
  }

  /** the gamepad's buttons for what the player is doing (on foot / driving), for a few seconds */
  private drawPadLegend(ctx: CanvasRenderingContext2D, cx: number, cy: number, items: [string, string][], alpha: number, small: boolean) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${small ? 11 : 13}px ${BODY}`;
    ctx.textBaseline = 'middle';
    const r = small ? 9 : 11, gap = small ? 10 : 14;
    const widths = items.map(([b, t]) => glyphW(b, r) + 5 + ctx.measureText(t).width);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1) + 20;
    let x = cx - total / 2;
    ctx.fillStyle = 'rgba(10,12,18,0.62)';
    roundRect(ctx, x, cy - r - 6, total, r * 2 + 12, r + 6);
    ctx.fill();
    x += 10;
    items.forEach(([b, t], i) => {
      const gw = glyphW(b, r);
      buttonGlyph(ctx, b, x + gw / 2, cy, r, 'pad');
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e8eaed';
      ctx.fillText(t, x + gw + 5, cy + 1);
      x += widths[i] + gap;
    });
    ctx.restore();
  }

  /** the height of what drawNet draws: the badge, and today's points under it when there are any */
  private netHeight(small: boolean) {
    const h = small ? 18 : 22;
    return this.g.host.live.score && this.g.online?.status.state === 'online' ? 2 * h + (small ? 4 : 6) : h;
  }

  /** "Aktivity": the one button that lists what there is to do (ActivitiesUi: the world events on and
   *  coming, the mini-games you start yourself), with when the next world event may come under it.
   *  It pulses until the panel was opened once. `place` picks its corner once its size is known. */
  private drawActivities(ctx: CanvasRenderingContext2D, small: boolean, place: (w: number, h: number) => { x: number; y: number }): Rect {
    const g = this.g;
    const f = liveForecast(g.host.live, !!g.online && g.paused);
    const sub = chipLine(f);
    const pad = g.input.pad.active;
    // the key as the player's input shows it: the U key cap, the pad's d-pad down, a tap on touch
    const kind = pad ? 'pad' : g.touch ? 'touch' : 'key';
    const label = pad ? '↓' : g.touch ? '☰' : 'U';
    const r = small ? 8 : 9;
    const gw = glyphW(label, r);
    const fs = small ? 12 : 14, fs2 = small ? 10 : 11;
    ctx.save();
    ctx.font = `700 ${fs}px ${BODY}`;
    const tw = ctx.measureText('Aktivity').width;
    ctx.font = `600 ${fs2}px ${BODY}`;
    const sw = sub ? ctx.measureText(sub).width : 0;
    const h = sub ? (small ? 32 : 38) : small ? 22 : 26;
    const w = 8 + gw + 8 + Math.max(tw, sw) + 10;
    const { x, y } = place(w, h);
    panel(ctx, x, y, w, h, small ? 9 : 11);
    // until it was opened once, a gentle gold pulse so a newcomer notices it
    const pulse = activitiesSeen() ? 0 : 0.5 + 0.5 * Math.sin(g.time * 3.5);
    roundRect(ctx, x, y, w, h, small ? 9 : 11);
    ctx.strokeStyle = pulse ? `rgba(255,214,0,${0.35 + pulse * 0.5})` : 'rgba(255,214,0,0.28)';
    ctx.lineWidth = pulse ? 1.8 : 1;
    ctx.stroke();
    buttonGlyph(ctx, label, x + 8 + gw / 2, y + h / 2, r, kind);
    const tx = x + 8 + gw + 8;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fs}px ${BODY}`;
    ctx.fillStyle = '#fff';
    ctx.fillText('Aktivity', tx, sub ? y + h * 0.34 : y + h / 2 + 1);
    if (sub) {
      ctx.font = `600 ${fs2}px ${BODY}`;
      // an event on: its orange; one about to come: gold
      ctx.fillStyle = f?.busy ? '#ffab40' : f && f.next !== null && f.next < 60 ? '#ffd740' : '#b0bec5';
      ctx.fillText(sub, tx, y + h * 0.72);
    }
    ctx.restore();
    return { x, y, w, h };
  }

  /** online status badge under the top-right panel: "● ONLINE · 12 hráčov · 38 ms" */
  private drawNet(ctx: CanvasRenderingContext2D, right: number, y: number, small: boolean) {
    const s = this.g.online!.status;
    let text: string, color: string;
    if (s.state === 'online') {
      const n = s.players;
      const hr = n === 1 ? 'hráč' : n >= 2 && n <= 4 ? 'hráči' : 'hráčov';
      text = `● ONLINE · ${n} ${hr} · ${Math.round(s.rtt)} ms`;
      color = '#69f0ae';
    } else if (s.state === 'failed' || s.state === 'closed') {
      text = '● OFFLINE';
      color = '#ff5252';
    } else {
      text = `● Pripájam sa…${s.retryIn > 0.5 ? ' ' + Math.ceil(s.retryIn) + ' s' : ''}`;
      color = '#ffd740';
    }
    ctx.font = `700 ${small ? 11 : 13}px ${BODY}`;
    const w = ctx.measureText(text).width + 16;
    const h = small ? 18 : 22;
    panel(ctx, right - w, y, w, h, h / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, right - 8, y + h / 2 + 1);
    const sc = this.g.host.live.score;
    if (sc && s.state === 'online') this.drawScore(ctx, right, y + h + (small ? 4 : 6), small, sc);
    if (s.state === 'reconnecting') {
      ctx.textAlign = 'center';
      ctx.font = `700 ${small ? 14 : 18}px ${BODY}`;
      outlined(ctx, 'Spojenie prerušené – pripájam sa…', this.g.viewW / 2, this.g.viewH * 0.18, '#ffd740');
    }
  }

  /** Online, under the connection badge: today's leaderboard points and rank (LeaderboardUi opens
   *  the whole board: L on a keyboard, "Rebríček" in the pause menu). */
  private drawScore(ctx: CanvasRenderingContext2D, right: number, y: number, small: boolean, sc: NonNullable<LiveState['score']>) {
    const dt = 1 / 60;
    this.shownPoints += (sc.d - this.shownPoints) * 0.15;
    if (Math.abs(sc.d - this.shownPoints) < 1) this.shownPoints = sc.d;
    if (sc.d > this.lastPoints) this.pointsFlash = 1;
    this.lastPoints = sc.d;
    this.pointsFlash = Math.max(0, this.pointsFlash - dt * 1.2);
    const rank = sc.r ? ` · ${sc.r}.${small ? '' : ' dnes'}` : small ? '' : ' dnes';
    const text = `🏆 ${formatPoints(this.shownPoints)} b${rank}`;
    // a keyboard shows which key opens the board; a touch screen has the pause menu's button
    const key = this.g.layout.touch ? '' : 'L';
    ctx.font = `700 ${small ? 11 : 13}px ${BODY}`;
    const tw = ctx.measureText(text).width;
    ctx.font = `700 ${small ? 9 : 10}px ${BODY}`;
    const kw = key ? ctx.measureText(key).width + 12 : 0;
    const h = small ? 18 : 22;
    const w = tw + kw + 16;
    panel(ctx, right - w, y, w, h, h / 2);
    if (this.pointsFlash > 0) {
      roundRect(ctx, right - w, y, w, h, h / 2);
      ctx.strokeStyle = `rgba(255,215,64,${this.pointsFlash})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    if (key) {
      // the key cap
      const kx = right - 8 - kw + 4, kh = h - 8;
      roundRect(ctx, kx, y + 4, kw - 6, kh, 3);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText(key, kx + (kw - 6) / 2, y + h / 2 + 1);
      ctx.textAlign = 'right';
    }
    ctx.font = `700 ${small ? 11 : 13}px ${BODY}`;
    ctx.fillStyle = '#ffd740';
    ctx.fillText(text, right - 8 - kw, y + h / 2 + 1);
  }

  private drawObjective(ctx: CanvasRenderingContext2D, text: string, L: HudLayout) {
    const W = L.W, small = L.small;
    const fs = small ? 13 : 16;
    ctx.font = `700 ${fs}px ${BODY}`;
    const maxW = L.touch ? Math.min(L.band.w - fs * 2, 560) : Math.min(W * 0.6, 560);
    const lines = wrapLines(ctx, text, maxW);
    const lh = small ? 17 : 21;
    const bw = L.touch ? Math.min(maxW + fs * 2, L.band.w) : Math.min(maxW + fs * 2, W - L.padL * 2);
    const bh = lines.length * lh + fs * 1.1;
    const bx = L.band.cx - bw / 2;
    const by = L.objective.y;
    panel(ctx, bx, by, bw, bh, bh / 2 > 20 ? 12 : bh / 2);
    ctx.fillStyle = GOLD;
    ctx.fillRect(bx, by, 3, bh);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => outlined(ctx, l, L.band.cx, by + fs * 0.55 + i * lh, '#fff59d'));
  }

  private drawWeaponPanel(ctx: CanvasRenderingContext2D, x: number, y: number, small: boolean) {
    const g = this.g;
    const w = g.player.weapon;
    const size = small ? 22 : 28;
    drawWeaponIcon(ctx, w, x + size / 2, y + size / 2, size * 0.42);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${small ? 13 : 16}px ${HEAD}`;
    const ammo = w === 'fist' ? '' : `  ${g.ammo[w]}`;
    outlined(ctx, WEAPONS[w].short + ammo, x + size + 6, y + size / 2, '#fff', 3);
  }

  private drawCombo(ctx: CanvasRenderingContext2D, combo: ComboState, x: number, y: number, small: boolean) {
    const t = Math.min(1, combo.timer);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${small ? 16 : 20}px ${HEAD}`;
    outlined(ctx, `${combo.label} ×${combo.mult}`, x, y, '#ffab40');
    const bw = small ? 90 : 120;
    roundRect(ctx, x, y + (small ? 11 : 13), bw, 4, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    roundRect(ctx, x, y + (small ? 11 : 13), bw * t, 4, 2);
    ctx.fillStyle = '#ffab40';
    ctx.fill();
  }

  /** arc speed gauge, bottom-centre, plus a nitro bar under it if `vehicle.nitro` is defined. */
  private drawSpeedo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, car: NonNullable<Game['player']['vehicle']>, small: boolean) {
    const kmh = Math.round(car.speed * 3.6);
    const top = 200;
    const frac = Math.min(1, kmh / top);
    const a0 = Math.PI * 0.78, a1 = Math.PI * 2.22;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = small ? 6 : 8;
    ctx.strokeStyle = 'rgba(10,10,14,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
    grad.addColorStop(0, '#29b6f6');
    grad.addColorStop(0.7, '#ffd600');
    grad.addColorStop(1, '#ff5252');
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac);
    ctx.stroke();
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${small ? 22 : 30}px ${HEAD}`;
    outlined(ctx, String(kmh), cx, cy - (small ? 2 : 4), '#fff');
    ctx.font = `700 ${small ? 9 : 11}px ${BODY}`;
    outlined(ctx, 'km/h', cx, cy + (small ? 14 : 18), '#cfd8dc', 2.5);

    // (a scooter or a bike has no nitro)
    const nitro = (car as unknown as { nitro?: number }).nitro;
    if (typeof nitro === 'number' && !car.spec.twoWheeler) {
      const bw = r * 1.5;
      const by = cy + r + (small ? 8 : 10);
      roundRect(ctx, cx - bw / 2, by, bw, 6, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
      roundRect(ctx, cx - bw / 2, by, bw * Math.max(0, Math.min(1, nitro)), 6, 3);
      ctx.fillStyle = '#7c4dff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      roundRect(ctx, cx - bw / 2, by, bw, 6, 3);
      ctx.stroke();
    }
  }

  /** touch aiming: a line out of the player while dragging from the fire button, and brackets on
   *  the target the fire button is locked onto */
  private drawTouchAim(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const t = g.input.touch;
    if (g.state !== 'play') return;
    const f = g.focus();
    const me = g.worldToScreen(f.x, f.y);
    if (t.aim.on) {
      const len = Math.min(g.viewW, g.viewH) * 0.22;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(me.x + t.aim.x * 18, me.y + t.aim.y * 18);
      ctx.lineTo(me.x + t.aim.x * len, me.y + t.aim.y * len);
      ctx.stroke();
      ctx.restore();
    }
    const tg = g.aimTarget;
    if (!tg) return;
    const p = g.worldToScreen(tg.x, tg.y);
    const r = Math.max(12, g.cam.scale * 0.9);
    const spin = g.time * 2;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineCap = 'round';
    for (const [w, color] of [[5, 'rgba(0,0,0,0.6)'], [2.5, '#18ffff']] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      for (let i = 0; i < 4; i++) {
        const a = spin + (i * Math.PI) / 2;
        ctx.beginPath();
        ctx.arc(0, 0, r, a - 0.35, a + 0.35);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawHitIndicators(ctx: CanvasRenderingContext2D, W: number, H: number, dt: number) {
    if (!this.hits.length) return;
    const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.46;
    for (const h of this.hits) {
      const a = Math.min(1, 1 - h.age);
      ctx.save();
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = '#40c4ff';
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, r, h.angle - 0.26, h.angle + 0.26);
      ctx.stroke();
      ctx.restore();
      h.age += dt;
    }
    this.hits = this.hits.filter((h) => h.age < 1);
  }

  /** clock + a small sun/moon/rain glyph, drawn as canvas paths (no emoji). */
  private drawClock(ctx: CanvasRenderingContext2D, right: number, y: number, small: boolean) {
    const g = this.g;
    const atmos = g.atmos;
    const fs = small ? 14 : 16;
    ctx.font = `700 ${fs}px ${BODY}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const text = atmos.clockText();
    const tw = ctx.measureText(text).width;
    shadowed(ctx, text, right, y, '#e8eef2');
    const r = fs * 0.4;
    const cx = right - tw - fs * 0.7 - r;
    if (atmos.rain > 0.15) drawRainGlyph(ctx, cx, y, r, atmos.rain);
    else if (atmos.daylight > 0.35) drawSunGlyph(ctx, cx, y, r, atmos.daylight);
    else drawMoonGlyph(ctx, cx, y, r);
  }

  private drawArrow(ctx: CanvasRenderingContext2D, tx: number, ty: number, color = GOLD) {
    const g = this.g;
    const f = g.focus();
    const a = Math.atan2(ty - f.y, tx - f.x);
    const d = Math.hypot(tx - f.x, ty - f.y);
    const cx = g.viewW / 2 + (tx - g.cam.x) * g.cam.scale;
    const cy = g.viewH / 2 + (ty - g.cam.y) * g.cam.scale;
    const onScreen = inPlay(g.layout, cx, cy);
    ctx.save();
    if (onScreen) {
      ctx.translate(cx, cy - 26 + Math.sin(g.time * 5) * 5);
      ctx.rotate(Math.PI / 2);
    } else {
      const e = edgePoint(g.layout, a);
      ctx.translate(e.x, e.y);
      ctx.rotate(a);
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-10, -11);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-10, 11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (!onScreen) {
      const e = edgePoint(g.layout, a, 28);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 12px ${BODY}`;
      outlined(ctx, `${Math.round(d)} m`, e.x, e.y, color);
    }
  }
}

/** the pad's buttons (standard mapping, Xbox face-button colours) and what they do */
const PAD_FOOT: [string, string][] = [['LS', 'chôdza'], ['RS', 'mierenie'], ['RT', 'streľba'], ['A', 'beh'], ['Y', 'nastúpiť'], ['B', 'zbraň'], ['⧉', 'mapa'], ['↓', 'aktivity']];
const PAD_CAR: [string, string][] = [['RT', 'plyn'], ['LT', 'brzda'], ['RB', 'ručná'], ['A', 'nitro'], ['X', 'klaksón'], ['RS', 'streľba'], ['↑', 'rádio'], ['Y', 'vystúpiť']];
/** on a scooter or a bike: no nitro, no radio, and the horn is a bell */
const PAD_BIKE: [string, string][] = [['RT', 'plyn'], ['LT', 'brzda'], ['RB', 'ručná'], ['X', 'zvonček'], ['RS', 'streľba'], ['Y', 'zosadnúť']];
const PAD_MENU: [string, string][] = [['✚', 'pohyb'], ['A', 'vybrať'], ['B', 'späť']];
const FACE: Record<string, string> = { A: '#2e9e44', B: '#d83a2e', X: '#2f6fd6', Y: '#e0b100' };

function glyphW(label: string, r: number) {
  return label.length > 1 && !FACE[label] ? r * 2.6 : r * 2;
}

/** A button as the player's input shows it: the pad's round face buttons (coloured) and pill
 *  shoulders and sticks, a keyboard key cap, or the touch screen's button. */
export function buttonGlyph(ctx: CanvasRenderingContext2D, label: string, cx: number, cy: number, r: number, kind: 'pad' | 'key' | 'touch') {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (kind === 'key') {
    ctx.fillStyle = '#eceff1';
    roundRect(ctx, cx - r, cy - r, r * 2, r * 2, r * 0.35);
    ctx.fill();
    ctx.fillStyle = '#b0bec5';
    ctx.fillRect(cx - r + 2, cy + r - 3, r * 2 - 4, 2);
    ctx.fillStyle = '#20242a';
    ctx.font = `800 ${r * 1.15}px ${BODY}`;
    ctx.fillText(label, cx, cy);
  } else if (kind === 'touch') {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${r * 1.2}px system-ui, sans-serif`;
    ctx.fillText(label, cx, cy + 1);
  } else {
    const face = FACE[label];
    const w = glyphW(label, r);
    ctx.fillStyle = face ?? '#3c4148';
    if (face) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      roundRect(ctx, cx - w / 2, cy - r * 0.8, w, r * 1.6, r * 0.8);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${face ? r * 1.1 : r * 0.85}px ${BODY}`;
    ctx.fillText(label, cx, cy + 0.5);
  }
  ctx.restore();
}

export function outlined(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, width = 4) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** softer alternative to `outlined`: a drop shadow instead of a heavy stroke, for less critical text */
function shadowed(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  // offset copies instead of shadowBlur, which is slow on software canvases
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillText(text, x + 1, y + 1.5);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillText(text, x, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** outlined text with a soft coloured glow behind it (cheap: a handful of offset copies, no shadowBlur) */
function glowText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, glow: string) {
  ctx.save();
  ctx.fillStyle = glow;
  for (const [dx, dy] of [[-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5]]) ctx.fillText(text, x + dx, y + dy);
  ctx.restore();
  outlined(ctx, text, x, y, color, 3.5);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** glassy dark panel: subtle vertical gradient, hairline border, faint inner top highlight. */
export function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 10) {
  roundRect(ctx, x, y, w, h, r);
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, 'rgba(32,34,42,0.68)');
  grad.addColorStop(1, 'rgba(10,11,15,0.72)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,214,0,0.16)';
  roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1));
  ctx.stroke();
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, color: string, bg: string, label: string, small: boolean) {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  if (frac > 0) {
    roundRect(ctx, x + 1, y + 1, Math.max(3, (w - 2) * frac), h - 2, (h - 2) / 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.stroke();
  void label;
  void small;
}

/** the toys' icons for the weapon panel and the touch button, drawn as canvas paths (no images):
 *  a tickling feather, a water pistol, a bubble gun with its wand, a confetti tube (docs/plans/non-violent.md) */
export function drawWeaponIcon(ctx: CanvasRenderingContext2D, kind: WeaponId, cx: number, cy: number, s: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = s * 0.14;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (kind === 'fist') {
    // a feather, for tickling: a curved quill with soft vanes
    ctx.rotate(-0.7);
    ctx.fillStyle = '#f8bbd0';
    ctx.beginPath();
    ctx.moveTo(-s * 0.95, 0);
    ctx.quadraticCurveTo(-s * 0.2, -s * 0.62, s * 0.95, -s * 0.08);
    ctx.quadraticCurveTo(-s * 0.1, s * 0.5, -s * 0.95, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = s * 0.07;
    for (const k of [-0.45, -0.1, 0.25]) {
      ctx.beginPath();
      ctx.moveTo(k * s, -s * 0.05);
      ctx.lineTo((k + 0.18) * s, -s * 0.34);
      ctx.moveTo(k * s, -s * 0.05);
      ctx.lineTo((k + 0.16) * s, s * 0.2);
      ctx.stroke();
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = s * 0.09;
    ctx.beginPath();
    ctx.moveTo(-s * 1.15, s * 0.06);
    ctx.quadraticCurveTo(-s * 0.1, -s * 0.12, s * 0.9, -s * 0.08);
    ctx.stroke();
  } else if (kind === 'pistol') {
    // a water pistol: a round orange body, a clear blue tank on top, a nozzle and a grip
    ctx.fillStyle = '#ff9800';
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, s * 0.12);
    ctx.lineTo(s * 0.18, s * 0.12);
    ctx.lineTo(s * 0.05, s * 0.8);
    ctx.lineTo(-s * 0.32, s * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-s * 0.05, 0, s * 0.8, s * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff9800';
    ctx.fillRect(s * 0.7, -s * 0.08, s * 0.35, s * 0.16);
    ctx.strokeRect(s * 0.7, -s * 0.08, s * 0.35, s * 0.16);
    ctx.fillStyle = '#4fc3f7';
    ctx.beginPath();
    ctx.ellipse(-s * 0.2, -s * 0.38, s * 0.42, s * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.ellipse(-s * 0.32, -s * 0.44, s * 0.14, s * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'uzi') {
    // a bubble gun: a pink body, the wand's ring in front, bubbles floating off it
    ctx.fillStyle = '#ec407a';
    ctx.beginPath();
    ctx.rect(-s * 0.2, s * 0.1, s * 0.3, s * 0.65);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-s * 0.25, -s * 0.02, s * 0.7, s * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#ab47bc';
    ctx.lineWidth = s * 0.16;
    ctx.beginPath();
    ctx.arc(s * 0.62, -s * 0.02, s * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(179,229,252,0.95)';
    ctx.lineWidth = s * 0.08;
    for (const [bx, by, br] of [[0.95, -0.62, 0.2], [0.55, -0.72, 0.13], [1.12, -0.25, 0.1]] as const) {
      ctx.beginPath();
      ctx.arc(bx * s, by * s, br * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    // a confetti tube: striped, a burst of paper out of its mouth
    ctx.rotate(-0.25);
    ctx.fillStyle = '#7e57c2';
    ctx.beginPath();
    ctx.moveTo(-s * 1.1, -s * 0.18);
    ctx.lineTo(s * 0.4, -s * 0.3);
    ctx.lineTo(s * 0.4, s * 0.3);
    ctx.lineTo(-s * 1.1, s * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffd54f';
    for (const k of [-0.75, -0.3, 0.12]) ctx.fillRect(k * s, -s * 0.24, s * 0.14, s * 0.48);
    const bits = ['#ff5252', '#ffeb3b', '#69f0ae', '#40c4ff', '#ff4081'];
    bits.forEach((c, i) => {
      const a = -0.9 + i * 0.45, r = s * (0.7 + (i % 2) * 0.3);
      ctx.fillStyle = c;
      ctx.save();
      ctx.translate(s * 0.45 + Math.cos(a) * r, Math.sin(a) * r);
      ctx.rotate(a * 2);
      ctx.fillRect(-s * 0.1, -s * 0.05, s * 0.2, s * 0.1);
      ctx.restore();
    });
  }
  ctx.restore();
}

function drawSunGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, strength: number) {
  ctx.save();
  ctx.fillStyle = `rgba(255,214,90,${0.6 + 0.4 * strength})`;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = r * 0.22;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.25);
    ctx.lineTo(x + Math.cos(a) * r * 1.75, y + Math.sin(a) * r * 1.75);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMoonGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.fillStyle = '#cfd8dc';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(20,24,32,0.92)';
  ctx.beginPath();
  ctx.arc(x + r * 0.45, y - r * 0.15, r * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawRainGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, intensity: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(207,213,219,0.95)';
  ctx.beginPath();
  ctx.arc(x - r * 0.35, y - r * 0.1, r * 0.6, 0, Math.PI * 2);
  ctx.arc(x + r * 0.25, y - r * 0.25, r * 0.7, 0, Math.PI * 2);
  ctx.arc(x + r * 0.15, y + r * 0.1, r * 0.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(120,180,235,${0.6 + 0.4 * intensity})`;
  ctx.lineWidth = r * 0.2;
  ctx.lineCap = 'round';
  for (const dx of [-0.35, 0.15, 0.55]) {
    ctx.beginPath();
    ctx.moveTo(x + dx * r, y + r * 0.7);
    ctx.lineTo(x + dx * r - r * 0.15, y + r * 1.25);
    ctx.stroke();
  }
  ctx.restore();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/** `maxLines` (0 = any) cuts a long text off with an ellipsis */
function wrapOutlined(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, color: string, up = false, maxLines = 0) {
  const lines = wrapLines(ctx, text, maxW);
  if (maxLines && lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] += '…';
  }
  const y0 = up ? y - (lines.length - 1) * lh : y;
  lines.forEach((l, i) => outlined(ctx, l, x, y0 + i * lh, color, 3.5));
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, glow: boolean) {
  if (glow) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    starPath(ctx, x, y, r * 1.6);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
  starPath(ctx, x, y, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function starPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}
