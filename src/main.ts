import './style.css';
import { Game } from './game/Game';
import type { MapJSON } from './shared/types';
import { NetSimHost } from './net/NetSimHost';
import { clearPendingJoin, JOIN_KEY, loadIdentity, newToken, saveIdentity, type Identity } from './net/identity';
import { randomNick } from './net/nicknames';
import { parseBootLinks } from './boot/links';
import { askNick } from './ui/askNick';
import { openModal, setPauseOnline, toast } from './ui/kit/dom';
import { handleAuthCallback, hasStoredSession, markPasswordResetPending } from './net/auth';
import { completePasswordReset, consumeClaimPending, offerClaimAndGoOnline, openChooser, resolveOnlineIdentity, wireAccountPauseControls } from './ui/AccountUi';

const $ = (id: string) => document.getElementById(id)!;
const QUALITY_KEY = 'blava-city-quality';
const QUALITY_LABEL: Record<Game['qualityPref'], string> = { auto: 'Auto', high: 'Vysoká', medium: 'Stredná', low: 'Nízka' };
const QUALITY_CYCLE: Game['qualityPref'][] = ['auto', 'high', 'medium', 'low'];
const FOOT_KEY = 'blava-city-foot-controls';
const FOOT_LABEL: Record<Game['footControls'], string> = { screen: 'podľa obrazovky', cursor: 'za kurzorom myši' };
/** game server; unset = single-player only (no Online button) */
const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

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
  if (links.photo) {
    // scripts/spots-gen.mjs drives window.__photo directly: no menu, HUD or simulation (loaded on
    // demand, so players never download the photo-mode code)
    $('loading').classList.add('hidden');
    const { bootPhotoMode } = await import('./game/features/PhotoMode');
    bootPhotoMode(data);
    return;
  }
  // a stored session counts as an identity too: a returning signed-in account skips straight to
  // loading, the same as a returning guest (resolveOnlineIdentity/AccountUi figures out which once it runs)
  const onlineBoot = links.online && !!SERVER_URL && (!!loadIdentity() || hasStoredSession());
  if (links.online) history.replaceState(null, '', location.pathname + location.search);
  // #join=nick-code (A3: party invite link): stash the code for NetSimHost.hello() to pick up and
  // clean the hash right away, before anything else touches location.hash.
  const joinCode = links.join && SERVER_URL ? links.join : null;
  if (joinCode) {
    try {
      sessionStorage.setItem(JOIN_KEY, joinCode);
    } catch {
      /* ignore: NetSimHost.hello() just won't find a code to send */
    }
    history.replaceState(null, '', location.pathname + location.search);
  }
  const game = new Game(canvas, data, { online: onlineBoot || !!joinCode });
  (window as unknown as { game: Game }).game = game;
  // an account e-mail link coming back (confirm sign-up, or a password reset — reset=1 always also
  // carries the same ?code=, so both exchange it the same way). Fire-and-forget: it's a quick local
  // round trip and shouldn't hold up the first frame.
  if (links.authCallback || links.reset) {
    void (async () => {
      const { signedIn } = await handleAuthCallback();
      if (links.reset) {
        markPasswordResetPending();
        if (signedIn) await completePasswordReset();
        else toast('Odkaz na obnovenie hesla je neplatný alebo vypršal.', '#ff8a80');
      } else if (signedIn) {
        await offerClaimAndGoOnline(); // tells the player, offers the claim, reloads into #online
      } else {
        toast('Účet potvrdený, môžeš sa prihlásiť.');
      }
    })();
  }
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
  btnOnline.onclick = () => {
    game.audio.init();
    openChooser(); // guest is the default/only option when accounts are off or already resolved
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
  // `claim`: sent once, right after a fresh sign-up that found local guest progress worth keeping
  // (part 2 wires the actual button; this just needs to be ready to call).
  const startOnline = async (id: Identity, claim = false) => {
    $('loading').classList.remove('hidden');
    $('loading-text').textContent = 'Pripájam sa na server…';
    const session = new NetSimHost(game, SERVER_URL, id, claim);
    try {
      await session.start();
    } catch (e) {
      // every failure path abandons this session: dispose it (closes the socket, clears its auth
      // refresh timer) so a failed attempt never leaks it
      session.dispose();
      const why = (e as Error).message;
      if (why === 'nick-taken') {
        // only a brand-new account's hello gets this (its chosen nickname is already taken): still
        // trying to join, so the pending #join code (if any) is left alone for the retry
        const nick = await askNick(id.nick, 'Skúsiť znova');
        if (nick) return startOnline({ ...id, nick }, claim);
        showMenu();
        return;
      }
      if (why === 'auth' || why === 'auth-unavailable') {
        clearPendingJoin();
        $('loading').classList.add('hidden');
        openModal({
          title: 'Odpojený',
          body: why === 'auth' ? 'Prihlásenie vypršalo – prihlás sa znova.' : 'Prihlásenie je teraz nedostupné.',
          buttons: [
            {
              label: 'Hrať ako hosť',
              primary: true,
              onClick: () => {
                const g = loadIdentity() ?? { token: newToken(), nick: randomNick() };
                saveIdentity(g);
                void startOnline(g);
              },
            },
          ],
        });
        return;
      }
      clearPendingJoin();
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
    setPauseOnline(true);
    void wireAccountPauseControls(game);
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
      Object.assign(game.input.touch.move, { x, y, on: true });
      knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`;
    };
    stick.addEventListener('pointerdown', (e) => {
      stick.setPointerCapture(e.pointerId);
      setStick(e);
    });
    stick.addEventListener('pointermove', (e) => game.input.touch.move.on && setStick(e));
    const end = () => {
      Object.assign(game.input.touch.move, { x: 0, y: 0, on: false });
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
        else if (code === 'fire') game.input.touch.fire = true;
        else game.input.touchButtons.add(code);
      });
      const up = () => (code === 'fire' ? (game.input.touch.fire = false) : game.input.touchButtons.delete(code));
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
      b.addEventListener('pointercancel', up);
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
    void (async () => {
      // rebuilt fresh each boot (guest, or an account when a Supabase session is stored — see
      // src/net/identity.ts): the reload that got us here is the one place account-ness is decided
      const id = await resolveOnlineIdentity();
      if (!id) {
        $('loading').classList.add('hidden');
        showMenu();
        return;
      }
      // consumed unconditionally: a guest identity must still clear it, or it could fire later
      // (without the prompt) once this device resolves to an account
      const claim = consumeClaimPending();
      void startOnline(id, !!id.account && claim);
    })();
    return;
  }
  if (joinCode) {
    // the page just loaded for this, so no reload is needed (unlike the #online button): a stored
    // identity (a signed-in account first, else the guest) joins straight away. A device with neither
    // gets the guest/account chooser; the code waits in sessionStorage across its reload into #online.
    showMenu();
    $('menu').classList.add('hidden');
    void (async () => {
      const id = await resolveOnlineIdentity();
      if (id) return startOnline(id);
      $('loading').classList.add('hidden');
      showMenu();
      openChooser();
    })();
    return;
  }
  $('loading').classList.add('hidden');
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname + location.search);
    startGame(false);
  } else showMenu();
}

boot();
