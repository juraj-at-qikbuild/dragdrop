// What the page's URL asks for at boot (docs/plans/social-events.md):
//  #online            reload into online play (the Online button does this)
//  #join=fero-k3x9q2  a party invite link: play online next to whoever sent it
//  #ref=fero-k3x9q2ab  a referral link: whoever sent it earns credits once you've played (docs/referrals.md)
//  ?photo             photo mode for the "Kde to je?" spot generator (scripts/spots-gen.mjs)
//  ?code=…            coming back from an account e-mail (Supabase PKCE); ?reset=1 a password reset
export interface BootLinks {
  online: boolean;
  /** the invite code (the part after the last '-'; the nick before it is decoration) */
  join: string | null;
  /** a referral code (after the last '-', like `join`) */
  ref: string | null;
  photo: boolean;
  authCallback: boolean;
  reset: boolean;
}

/** Into online play: `#online` and a fresh load (main.ts's onlineBoot takes it from there). */
export function goOnline() {
  location.hash = 'online';
  location.reload();
}

/** Online play has started: `#online` goes back into the address bar (the boot took it out), so a
 *  reload, a restored tab or a phone reopening a discarded page comes straight back online
 *  (docs/plans/pause-resume.md). */
export function markOnline() {
  history.replaceState(null, '', location.pathname + location.search + '#online');
}

/** Back to the plain main menu: the page loads again without `#online` (or any other hash), so it
 *  starts offline. Every way out of online play goes through here. */
export function goToMenu() {
  location.href = location.pathname + location.search;
}

export function parseBootLinks(hash: string, search: string): BootLinks {
  const q = new URLSearchParams(search);
  const m = /^#join=(?:[^#&?]*-)?([a-z0-9]{4,12})$/i.exec(hash);
  const r = /^#ref=(?:[^#&?]*-)?([a-z0-9]{4,12})$/i.exec(hash);
  return {
    online: hash === '#online',
    join: m ? m[1].toLowerCase() : null,
    ref: r ? r[1].toLowerCase() : null,
    photo: q.has('photo'),
    authCallback: q.has('code'),
    reset: q.get('reset') === '1',
  };
}
