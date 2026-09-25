/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** wss:// URL of the game server; when unset the game is single-player only */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
