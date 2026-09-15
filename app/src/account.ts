/**
 * The signed-in account's domain, shown before each sidebar thread title as
 * `[acme.com] Q3 launch review`.
 *
 * It is configuration rather than data because **the service exposes no
 * account**: there is no auth, no `/me` endpoint, and `ThreadDto` carries only
 * `{id, title, protocol, updated_at}`. The requirement names a source of truth
 * that does not exist in this system.
 *
 * `acme.com` is the brief's own illustration, kept as the default so the
 * feature is visible out of the box — but it is a stand-in, not a decision, and
 * lives behind an env var to say so:
 *
 *   VITE_ACCOUNT_DOMAIN=yourcompany.com npm run dev
 *
 * When a real account endpoint exists this becomes the one place to change.
 * See `docs/DECISIONS.md` §10.
 */
export const ACCOUNT_DOMAIN = import.meta.env.VITE_ACCOUNT_DOMAIN ?? "acme.com";
