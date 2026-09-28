import './style.css';
import { Game } from './game/Game';
import { TouchControls } from './ui/TouchControls';
import type { MapJSON } from './shared/types';
import { NetSimHost } from './net/NetSimHost';
import { clearPendingJoin, JOIN_KEY, loadIdentity, newToken, saveIdentity, type Identity } from './net/identity';
import { randomNick } from './net/nicknames';
import { goToMenu, markOnline, parseBootLinks } from './boot/links';
import { askNick } from './ui/askNick';
import { addPauseControl, openModal, setPauseOnline, toast } from './ui/kit/dom';
import { setting } from './ui/kit/settings';
import { KEYS } from './game/Input';
import { handleAuthCallback, hasStoredSession, markPasswordResetPending } from './net/auth';
import { continueNote, loadLastPlayed, noteOffline, noteOnline } from './net/lastSession';
import { LIVERY_NONE } from './shared/entities/Vehicle';
import { spawnAt } from './shared/world/spawns';
import type { OnboardingUi, Welcome } from './game/features/OnboardingUi';
import { markIntro } from './game/features/onboarding/seen';
import {
  completePasswordReset, consumeClaimPending, continueOnline, hasOnlineIdentity, offerClaimAndGoOnline, openChooser, resolveOnlineIdentity, wireAccountPauseControls,
} from './ui/AccountUi';

const $ = (id: string) => document.getElementById(id)!;
const QUALITY_KEY = 'blava-city-quality';
const QUALITY_LABEL: Record<Game['qualityPref'], string> = { auto: 'Auto', high: 'Vysoká', medium: 'Stredná', low: 'Nízka' };
const QUALITY_CYCLE: Game['qualityPref'][] = ['auto', 'high', 'medium', 'low'];
const FOOT_KEY = 'blava-city-foot-controls';
const FOOT_LABEL: Record<Game['footControls'], string> = { screen: 'podľa obrazovky', cursor: 'za kurzorom myši' };
const DRIVE_LABEL: Record<Game['driveControls'], string> = { direction: 'Smer', classic: 'Klasické' };
/** touch: how close the camera is (a factor on the automatic zoom, like the mouse wheel's) */
type CameraPref = 'near' | 'normal' | 'far';
const CAMERA_ZOOM: Record<CameraPref, number> = { near: 1.2, normal: 1, far: 0.85 };
const CAMERA_LABEL: Record<CameraPref, string> = { near: 'bližšie', normal: 'normálna', far: 'ďalej' };
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
  // touch screens: the driving scheme and how close the camera is, in the controls panel and the
  // pause menu; jobs and the party (J and N on a keyboard) from the pause menu
  if (game.touch) {
    const drive = setting<Game['driveControls']>('drive-controls', 'direction', (v): v is Game['driveControls'] => v === 'direction' || v === 'classic');
    const camera = setting<CameraPref>('camera', 'normal', (v): v is CameraPref => typeof v === 'string' && v in CAMERA_ZOOM);
    game.driveControls = drive.get();
    game.zoomPref = CAMERA_ZOOM[camera.get()];
    for (const cls of ['opt-drive', 'opt-camera']) {
      const b = document.createElement('button');
      b.className = cls;
      addPauseControl(b);
    }
    const pauseKey = (label: string, code: string, onlineOnly: boolean) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        game.setPaused(false);
        game.input.press(code);
      };
      addPauseControl(b, { onlineOnly });
    };
    pauseKey('Práca: kuriér, taxi', KEYS.jobs, false);
    pauseKey('Partia', KEYS.party, true);
    const drives = document.querySelectorAll<HTMLButtonElement>('.opt-drive');
    const cams = document.querySelectorAll<HTMLButtonElement>('.opt-camera');
    const show = () => {
      drives.forEach((b) => (b.textContent = `Riadenie auta: ${DRIVE_LABEL[game.driveControls]}`));
      cams.forEach((b) => (b.textContent = `Kamera: ${CAMERA_LABEL[camera.get()]}`));
    };
    drives.forEach((b) => {
      b.onclick = () => {
        game.driveControls = game.driveControls === 'direction' ? 'classic' : 'direction';
        drive.set(game.driveControls);
        show();
      };
    });
    cams.forEach((b) => {
      b.onclick = () => {
        const order = Object.keys(CAMERA_ZOOM) as CameraPref[];
        const next = order[(order.indexOf(camera.get()) + 1) % order.length];
        camera.set(next);
        game.zoomPref = CAMERA_ZOOM[next];
        show();
      };
    });
    show();
    $('btn-tips').onclick = () => {
      game.touchUi?.tips.reset();
      toast('Tipy sa ukážu znova počas hry.');
    };
    // the keyboard's controls fold away under the touch ones
    document.querySelector('details.keyboard')?.removeAttribute('open');
  }
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
  /** the greeting as the player comes into the city, and a newcomer's introduction before it */
  const onboarding = game.features.find((f) => f.id === 'onboarding') as OnboardingUi;

  const showMenu = () => {
    mode = 'menu';
    game.running = false;
    $('menu').classList.remove('hidden');
    $('pause').classList.add('hidden');
    $('btn-continue').classList.toggle('hidden', !Game.hasSave() && !game.save.money);
    refreshOnlineButton();
    game.audio.setStation(null);
    game.audio.engine(0, 0, false);
    game.audio.siren(0);
  };
  /** `welcome`: online, the first message (see onlineWelcome) */
  const startGame = (fresh: boolean, welcome?: Welcome) => {
    game.audio.init();
    if (fresh) {
      // starting over: they've played before, so the new game starts without the introduction
      markIntro('offline');
      game.discardSave();
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
    const t = game.touch;
    if (game.online) {
      onboarding.greet(welcome ?? onlineWelcome(null, false));
      return;
    }
    noteOffline();
    if (!game.save.done.length && !game.save.found.length) {
      // where the game put them (a random spawn place)
      const at = spawnAt(game.player.x, game.player.y);
      const where = at ? `${at.name}. ` : '';
      onboarding.greet({
        title: 'Vitaj v Bratislave',
        text: t ? `${where}Nájdi žltú telefónnu búdku ☎ (mapa: ťukni na minimapu) alebo si jednoducho ukradni auto.` : `${where}Nájdi žltú telefónnu búdku ☎ (mapa: M) alebo si jednoducho ukradni auto (F).`,
        secs: 7,
        newcomer: true,
      });
    }
  };
  /** The first message in the shared city: back where they left off, back in the city, or the
   *  first-time tips (a newcomer, who may get the introduction first). `resumed`: the server's welcome
   *  (null from an older server). */
  const onlineWelcome = (resumed: NetSimHost['resumed'], returning: boolean): Welcome => {
    const t = game.touch;
    if (resumed === 'saved' || resumed === 'live') return { title: 'Vitaj späť!', text: 'Pokračuješ tam, kde si skončil.', secs: 6, newcomer: false };
    if (returning) return { title: 'Vitaj späť v meste', text: t ? 'Mapa: ťukni na minimapu.' : 'Mapa: M.', secs: 6, newcomer: false };
    return {
      title: 'Vitaj v spoločnom meste',
      text: t ? 'Všetci hráči sú v jednej Bratislave. Ukradni si auto (žlté tlačidlo pri aute), mapa: ťukni na minimapu.' : 'Všetci hráči sú v jednej Bratislave. Ukradni si auto (F), mapa: M.',
      secs: 6,
      newcomer: true,
    };
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
  $('btn-resume').onclick = () => game.setPaused(false);
  $('btn-mute').onclick = () => {
    game.audio.setMuted(!game.audio.muted);
    $('btn-mute').textContent = game.audio.muted ? 'Zvuk: vypnutý' : 'Zvuk: zapnutý';
  };
  $('btn-quit').onclick = () => {
    // online it reads "Odísť z mesta": leaving the shared city, after saying what that keeps
    if (game.online) return confirmLeave();
    game.setPaused(false);
    game.persist();
    showMenu();
  };
  // --------------------------------------------------------------- online
  const btnOnline = $('btn-online');
  const menuButtons = btnOnline.parentElement!;
  /** "Online" for a new player; "Pokračovať online · Obchodná · pred 12 min" on a device that has
   *  played online before, first in the menu when online is what it played last */
  function refreshOnlineButton() {
    if (!SERVER_URL) return;
    const known = hasOnlineIdentity();
    const last = loadLastPlayed();
    const small = document.createElement('small');
    small.textContent = ` · ${(known && continueNote(last)) || 'spoločné mesto'}`;
    btnOnline.replaceChildren(known ? 'Pokračovať online' : 'Online', small);
    if (known && last?.mode === 'online') menuButtons.prepend(btnOnline);
    else menuButtons.insertBefore(btnOnline, $('btn-controls'));
  }
  if (SERVER_URL) btnOnline.classList.remove('hidden');
  btnOnline.onclick = () => {
    game.audio.init();
    // a device that has played online goes straight back; a new one picks guest or account first
    if (hasOnlineIdentity()) continueOnline();
    else openChooser(); // guest is the default/only option when accounts are off or already resolved
  };
  /** where the player is now, for the menu's "Pokračovať online · Obchodná" */
  const placeOf = () => game.street.name || game.quarter || game.district || '';
  /** what leaving keeps and what it ends, going by what the player is in the middle of */
  const leaveLines = (): string[] => {
    const host = game.host;
    // a server that holds party seats, brings cars back and makes a wanted player wait
    const kept = host instanceof NetSimHost && host.serverPresence;
    const lines = ['Peniaze, hračky a miesto sa uložia. Keď sa vrátiš, pokračuješ tu.'];
    const car = game.player.vehicle;
    if (kept && car && car.kind !== 'police' && car.livery === LIVERY_NONE && !car.mission) lines.push('Auto odíde s tebou a počká na teba.');
    if (host.live.party) lines.push(kept ? 'Partia ti podrží miesto 15 minút.' : 'Z partie odídeš.');
    if (host.live.race) lines.push('Rozbehnutý závod prehráš.');
    if (host.live.job) lines.push('Práca sa skončí.');
    if (kept && game.state === 'downed') lines.push('Premočený mrzneš: odchodom skončíš v nemocnici, kde ťa vysušia.');
    else if (kept && game.wanted > 0) lines.push('Si hľadaný: tvoja postava zostane v meste ešte 10 sekúnd.');
    return lines;
  };
  const confirmLeave = () => {
    const body = document.createElement('div');
    for (const line of leaveLines()) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = line;
      body.appendChild(p);
    }
    openModal({
      title: 'Odísť z mesta?',
      body,
      buttons: [
        {
          label: 'Odísť z mesta',
          primary: true,
          onClick: () => {
            noteOnline(placeOf());
            game.host.dispose(); // sends `leave`
            goToMenu();
          },
        },
        { label: 'Zostať', onClick: () => {} },
      ],
    });
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
      back.onclick = () => goToMenu();
      $('loading').appendChild(back);
      return;
    }
    game.setHost(session);
    // from here a reload (or a restored tab) comes straight back online
    markOnline();
    const last = loadLastPlayed();
    // the HUD doesn't know the street yet: keep the last one until the next note (every 10 s)
    noteOnline(last?.online?.place ?? '');
    btnNick.classList.remove('hidden');
    $('btn-quit').textContent = 'Odísť z mesta';
    setPauseOnline(true);
    void wireAccountPauseControls(game);
    $('loading').classList.add('hidden');
    startGame(false, onlineWelcome(session.resumed, !!last?.online));
  };
  game.onPause = (p) => $('pause').classList.toggle('hidden', !p);

  // touch controls (a phone or tablet, or ?touch=1)
  if (game.touch) game.touchUi = new TouchControls(game);

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    if (mode === 'play') {
      game.update(dt);
      game.touchUi?.update();
      game.draw();
    } else {
      game.touchUi?.update();
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
  // The page going hidden (another tab, the phone's home screen) opens the pause menu, online and
  // offline: online the server then knows the player is away. Back in view, the menu is waiting, and a
  // dropped connection retries at once rather than after its backoff.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (mode === 'play') game.setPaused(true);
    } else if (game.host instanceof NetSimHost) game.host.retryNow();
  });
  addEventListener('online', () => {
    if (game.host instanceof NetSimHost) game.host.retryNow();
  });
  // where they are in the shared city, for the menu's "Pokračovať online" next time
  const noteHere = () => {
    if (mode === 'play' && game.online?.status.state === 'online') noteOnline(placeOf());
  };
  setInterval(noteHere, 10_000);
  addEventListener('pagehide', noteHere);
  // browsers only allow audio after a user gesture
  const unlock = () => mode === 'play' && game.audio.init();
  addEventListener('keydown', unlock);
  addEventListener('pointerdown', unlock);
  // iOS only counts the end of a touch as the gesture that may start audio
  addEventListener('pointerup', unlock);

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
