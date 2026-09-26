/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** wss:// URL of the game server; when unset the game is single-player only */
  readonly VITE_SERVER_URL?: string;
  /** Supabase project URL; with VITE_SUPABASE_PUBLISHABLE_KEY, enables account play (src/net/auth.ts) */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (browser-safe) API key */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
