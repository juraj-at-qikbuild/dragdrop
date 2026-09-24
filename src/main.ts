import './style.css';
import { Game } from './game/Game';
import type { MapJSON } from './types';

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  const canvas = $('game') as HTMLCanvasElement;
  let data: MapJSON;
  try {
    const res = await fetch(new URL('data/bratislava.json', document.baseURI));
    data = await res.json();
  } catch (e) {
    $('loading-text').textContent = 'Nepodarilo sa načítať mapu Bratislavy. Skús obnoviť stránku.';
    throw e;
  }
  const game = new Game(canvas, data);
  (window as unknown as { game: Game }).game = game;
  // attract mode (menu) doesn't call game.update, so atmos never ticks there.
  // For a first-time visitor (no save yet, so no meaningful saved clock) park
  // it at a nice golden hour for the background instead of the 9am default.
  if (!Game.hasSave() && !game.save.money && !new URLSearchParams(location.search).has('t')) game.atmos.setTime(18.4);

  let mode: 'menu' | 'play' = 'menu';
  let attractT = 0;
  const attractPath = ['castle', 'cathedral', 'snp', 'eurovea', 'blue', 'michael', 'main'].map((id) => game.world.landmark(id));

  const showMenu = () => {
    mode = 'menu';
    game.running = false;
    $('menu').classList.remove('hidden');
    $('pause').classList.add('hidden');
    $('btn-continue').classList.toggle('hidden', !Game.hasSave() && !game.save.money);
    game.audio.setStation(null);
    game.audio.engine(0, 0, false);
    game.audio.siren(0);
  };
  const startGame = (fresh: boolean) => {
    game.audio.init();
    if (fresh) {
      Game.clearSave();
      location.hash = 'new';
      location.reload();
      return;
    }
    mode = 'play';
    game.running = true;
    $('menu').classList.add('hidden');
    game.cam.x = game.player.x;
    game.cam.y = game.player.y;
    game.ai.prewarm();
    if (!game.save.done.length && !game.save.found.length)
      game.message('Vitaj v Bratislave', 'Hlavné námestie. Nájdi žltú telefónnu búdku ☎ (mapa: M) alebo si jednoducho ukradni auto (F).', 7);
  };

  $('btn-new').onclick = () => startGame(!!(Game.hasSave() || game.save.money));
  $('btn-continue').onclick = () => startGame(false);
  $('btn-controls').onclick = () => {
    $('panel-controls').classList.toggle('hidden');
    $('panel-credits').classList.add('hidden');
  };
  $('btn-credits').onclick = () => {
    $('panel-credits').classList.toggle('hidden');
    $('panel-controls').classList.add('hidden');
  };
  $('btn-resume').onclick = () => {
    game.paused = false;
    $('pause').classList.add('hidden');
  };
  $('btn-mute').onclick = () => {
    game.audio.setMuted(!game.audio.muted);
    $('btn-mute').textContent = game.audio.muted ? 'Zvuk: vypnutý' : 'Zvuk: zapnutý';
  };
  $('btn-quit').onclick = () => {
    game.paused = false;
    game.persist();
    showMenu();
  };
  game.onPause = (p) => $('pause').classList.toggle('hidden', !p);

  // touch controls
  if (matchMedia('(pointer: coarse)').matches) {
    $('touch').classList.remove('hidden');
    const stick = $('stick'), knob = $('knob');
    const setStick = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      let x = (e.clientX - r.left - r.width / 2) / (r.width / 2);
      let y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
      const l = Math.hypot(x, y);
      if (l > 1) (x /= l), (y /= l);
      game.input.stick = { x, y, active: true };
      knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`;
    };
    stick.addEventListener('pointerdown', (e) => {
      stick.setPointerCapture(e.pointerId);
      setStick(e);
    });
    stick.addEventListener('pointermove', (e) => game.input.stick.active && setStick(e));
    const end = () => {
      game.input.stick = { x: 0, y: 0, active: false };
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    document.querySelectorAll<HTMLButtonElement>('.tbtns button').forEach((b) => {
      const code = b.dataset.code!;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        game.audio.init();
        if (code === 'KeyF' || code === 'KeyM') game.input.press(code);
        else game.input.touchButtons.add(code);
      });
      const up = () => game.input.touchButtons.delete(code);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
    });
  }

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    if (mode === 'play') {
      game.update(dt);
      game.draw();
    } else {
      // attract mode: slow flight between landmarks
      attractT += dt * 0.06;
      const i = Math.floor(attractT) % attractPath.length;
      const a = attractPath[i], b = attractPath[(i + 1) % attractPath.length];
      const t = attractT % 1;
      const s = t * t * (3 - 2 * t);
      game.cam.x = a.x + (b.x - a.x) * s;
      game.cam.y = a.y + (b.y - a.y) * s;
      game.cam.scale = Math.min(game.viewW, game.viewH) / 140;
      game.time += dt;
      game.draw(false);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  $('loading').classList.add('hidden');
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname + location.search);
    startGame(false);
  } else showMenu();
  addEventListener('beforeunload', () => game.persist());
  // browsers only allow audio after a user gesture
  const unlock = () => mode === 'play' && game.audio.init();
  addEventListener('keydown', unlock);
  addEventListener('pointerdown', unlock);
}

boot();
