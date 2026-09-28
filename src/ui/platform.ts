// A phone's browser around the game: fullscreen held sideways, the screen kept awake while playing,
// and on an iPhone (no fullscreen for a page there) a hint to add the game to the home screen, where
// it opens without the browser's bars (public/manifest.webmanifest, the apple-mobile-web-app tags in
// index.html). Every call is a best effort: a browser without the API, or one that says no, leaves
// the game as it was.

type Lockable = ScreenOrientation & { lock?: (o: 'landscape') => Promise<void> };

/** opened from the home screen (the manifest's fullscreen, or iOS's standalone) */
export function standalone(): boolean {
  return matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** an iPhone or iPod (an iPad has fullscreen; one that says it's a Mac, with touch, too) */
export function isIPhone(): boolean {
  return /iPhone|iPod/.test(navigator.userAgent);
}

/** Fullscreen, and the screen locked sideways where the browser allows it (Android's Chrome does in
 *  fullscreen). Call from a tap: browsers only allow it in answer to one. */
export async function enterFullscreen(): Promise<void> {
  const el = document.documentElement;
  if (standalone() || document.fullscreenElement || !el.requestFullscreen) return;
  try {
    await el.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return;
  }
  try {
    await (screen.orientation as Lockable | undefined)?.lock?.('landscape');
  } catch {
    /* not allowed here: the "turn it sideways" hint still shows */
  }
}

/** the screen kept on while playing (a tram ride or the map, a minute without a touch, would dim it) */
export class WakeLock {
  private lock: { release(): Promise<void> } | null = null;
  private want = false;

  constructor() {
    // the browser lets go of it when the page is hidden: take it again on the way back
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.want) void this.take();
    });
  }

  set(on: boolean) {
    if (on === this.want) return;
    this.want = on;
    if (on) void this.take();
    else {
      void this.lock?.release().catch(() => {});
      this.lock = null;
    }
  }

  private async take() {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl || this.lock) return;
    try {
      const l = await wl.request('screen');
      if (!this.want) void l.release().catch(() => {});
      else {
        this.lock = l;
        (l as unknown as EventTarget).addEventListener?.('release', () => {
          if (this.lock === l) this.lock = null;
        });
      }
    } catch {
      /* low battery, or not allowed */
    }
  }
}
