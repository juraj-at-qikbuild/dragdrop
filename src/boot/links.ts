// What the page's URL asks for at boot (docs/plans/social-events.md):
//  #online            reload into online play (the Online button does this)
//  #join=fero-k3x9q2  a party invite link: play online next to whoever sent it
//  ?photo             photo mode for the "Kde to je?" spot generator (scripts/spots-gen.mjs)
//  ?code=…            coming back from an account e-mail (Supabase PKCE); ?reset=1 a password reset
export interface BootLinks {
  online: boolean;
  /** the invite code (the part after the last '-'; the nick before it is decoration) */
  join: string | null;
  photo: boolean;
  authCallback: boolean;
  reset: boolean;
}

export function parseBootLinks(hash: string, search: string): BootLinks {
  const q = new URLSearchParams(search);
  const m = /^#join=(?:[^#&?]*-)?([a-z0-9]{4,12})$/i.exec(hash);
  return {
    online: hash === '#online',
    join: m ? m[1].toLowerCase() : null,
    photo: q.has('photo'),
    authCallback: q.has('code'),
    reset: q.get('reset') === '1',
  };
}
