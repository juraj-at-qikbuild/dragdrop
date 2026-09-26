import './style.css';
import { Game } from './game/Game';
import type { MapJSON } from './shared/types';
import { NetSimHost } from './net/NetSimHost';
import { loadIdentity, newToken, saveIdentity, type Identity } from './net/identity';
import { randomNick } from './net/nicknames';
import { cleanNick } from './shared/net/protocol';
import { parseBootLinks } from './boot/links';

const $ = (id: string) => document.getElementById(id)!;
const QUALITY_KEY = 'blava-city-quality';
const QUALITY_LABEL: Record<Game['qualityPref'], string> = { auto: 'Auto', high: 'Vysoká', medium: 'Stredná', low: 'Nízka' };
const QUALITY_CYCLE: Game['qualityPref'][] = ['auto', 'high', 'medium', 'low'];
const FOOT_KEY = 'blava-city-foot-controls';
const FOOT_LABEL: Record<Game['footControls'], string> = { screen: 'podľa obrazovky', cursor: 'za kurzorom myši' };
/** game server; unset = single-player only (no Online button) */
const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

/** Nickname prompt. Resolves with a valid nickname, or null when cancelled. */
function askNick(initial: string, okLabel: string): Promise<string | null> {
  const box = $('nick'), input = $('nick-input') as HTMLInputElement, err = $('nick-error');
  ($('nick-ok') as HTMLButtonElement).textContent = okLabel;
  input.value = initial;
  err.classList.add('hidden');
  box.classList.remove('hidden');
  setTimeout(() => input.select(), 0);
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      box.classList.add('hidden');
      ($('nick-form') as HTMLFormElement).onsubmit = null;
      $('nick-cancel').onclick = null;
      resolve(v);
    };
    $('nick-roll').onclick = () => {
      input.value = randomNick();
      input.focus();
    };
    ($('nick-form') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      const n = cleanNick(input.value);
      if (!n) return err.classList.remove('hidden');
      done(n);
    };
    $('nick-cancel').onclick = () => done(null);
  });
}

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
  // What the URL asks for (src/boot/links.ts): online play, a party invite, photo mode, an account
  // e-mail coming back. Online play boots through a reload with #online, so the page starts from a
  // clean world and the offline save is never touched (the online profile is separate).
  const links = parseBootLinks(location.hash, location.search);
  const onlineBoot = links.online && !!SERVER_URL && !!loadIdentity();
  if (links.online) history.replaceState(null, '', location.pathname + location.search);
  const game = new Game(canvas, data, { online: onlineBoot });
  (window as unknown as { game: Game }).game = game;
  try {
    const saved = localStorage.getItem(QUALITY_KEY) as Game['qualityPref'] | null;
    if (saved && QUALITY_CYCLE.includes(saved)) game.qualityPref = saved;
  } catch {
    /* ignore */
  }
  const btnQuality = document.getElementById('btn-quality') as HTMLButtonElement | null;
  if (btnQuality) {
    btnQuality.textContent = `Grafika: ${QUALITY_LABEL[game.qualityPref]}`;
    btnQuality.onclick = () => {
      const i = QUALITY_CYCLE.indexOf(game.qualityPref);
      game.qualityPref = QUALITY_CYCLE[(i + 1) % QUALITY_CYCLE.length];
      btnQuality.textContent = `Grafika: ${QUALITY_LABEL[game.qualityPref]}`;
      try {
        localStorage.setItem(QUALITY_KEY, game.qualityPref);
      } catch {
        /* ignore */
      }
    };
  }
  // on-foot controls toggle, in both the main menu's controls panel and the pause menu
  try {
    const saved = localStorage.getItem(FOOT_KEY);
    if (saved === 'screen' || saved === 'cursor') game.footControls = saved;
  } catch {
    /* ignore */
  }
  const footButtons = document.querySelectorAll<HTMLButtonElement>('.opt-foot');
  const showFoot = () => footButtons.forEach((b) => (b.textContent = `Chôdza: ${FOOT_LABEL[game.footControls]}`));
  showFoot();
  footButtons.forEach((b) => {
    b.onclick = () => {
      game.footControls = game.footControls === 'screen' ? 'cursor' : 'screen';
      showFoot();
      try {
        localStorage.setItem(FOOT_KEY, game.footControls);
      } catch {
        /* ignore */
      }
    };
  });
  // canvas text (HUD/minimap) waits on the Google Fonts load before it looks right;
  // a re-draw isn't needed since the loop redraws every frame regardless.
  document.fonts?.ready?.catch(() => {});
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
    game.prewarm();
    if (game.online) game.message('Vitaj v spoločnom meste', 'Všetci hráči sú v jednej Bratislave. Ukradni si auto (F), mapa: M.', 6);
    else if (!game.save.done.length && !game.save.found.length)
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
    if (game.online) {
      // leave the shared world and come back to a fresh offline menu
      game.host.dispose();
      location.reload();
      return;
    }
    game.persist();
    showMenu();
  };
  // --------------------------------------------------------------- online
  const btnOnline = $('btn-online');
  if (SERVER_URL) btnOnline.classList.remove('hidden');
  btnOnline.onclick = async () => {
    game.audio.init();
    let id = loadIdentity();
    if (!id) {
      const nick = await askNick(randomNick(), 'Hrať online');
      if (!nick) return;
      id = { token: newToken(), nick };
      saveIdentity(id);
    }
    location.hash = 'online';
    location.reload();
  };
  const btnNick = $('btn-nick');
  btnNick.onclick = async () => {
    const s = game.online;
    if (!s) return;
    const nick = await askNick(s.nick, 'Uložiť');
    if (!nick) return;
    s.setNick(nick);
    const id = loadIdentity();
    if (id) saveIdentity({ ...id, nick });
  };
  const startOnline = async (id: Identity) => {
    $('loading').classList.remove('hidden');
    $('loading-text').textContent = 'Pripájam sa na server…';
    const session = new NetSimHost(game, SERVER_URL, id);
    try {
      await session.start();
    } catch (e) {
      const why = (e as Error).message;
      $('loading-text').textContent =
        why === 'version' ? 'Nová verzia hry – obnov stránku.' : why === 'full' ? 'Server je plný. Skús to neskôr.' : 'Server je nedostupný. Skús to neskôr.';
      const back = document.createElement('button');
      back.textContent = 'Späť do menu';
      back.onclick = () => location.reload();
      $('loading').appendChild(back);
      return;
    }
    game.setHost(session);
    btnNick.classList.remove('hidden');
    $('loading').classList.add('hidden');
    startGame(false);
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

  addEventListener('beforeunload', () => game.persist());
  // browsers only allow audio after a user gesture
  const unlock = () => mode === 'play' && game.audio.init();
  addEventListener('keydown', unlock);
  addEventListener('pointerdown', unlock);

  if (onlineBoot) {
    showMenu();
    $('menu').classList.add('hidden');
    void startOnline(loadIdentity()!);
    return;
  }
  $('loading').classList.add('hidden');
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname + location.search);
    startGame(false);
  } else showMenu();
}

boot();
