/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Domain shown in square brackets before each sidebar thread title.
   *
   * Configurable because the service exposes no account to derive it from —
   * see `docs/DECISIONS.md` §10. Set it in `.env.local` or the environment:
   *
   *   VITE_ACCOUNT_DOMAIN=yourcompany.com npm run dev
   */
  readonly VITE_ACCOUNT_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
