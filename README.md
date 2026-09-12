# DOJO Streaming Agent Console — Starter

Your assignment is in the PDF you received. This repo is a starting point, not a constraint: a working app shell, a mock assistant service, and recorded conversation fixtures. Use what is here, improve it, or replace it entirely.

## Layout

```
app/      React 19 + TypeScript + Tailwind. Shell (thread list, composer,
          transport client) is done. The placeholder to replace is in
          app/src/transcript/ — but nothing here is off limits.
server/   The mock assistant service. Serves the recorded fixtures over SSE.
          It has its own README — read it.
fixtures/ Recorded conversation streams the service replays.
```

## Run it

Node 20.19+ or 22+ (there is an `.nvmrc`). Two terminals:

```sh
cd server && npm install && npm start     # http://localhost:8787
cd app && npm install && npm run dev      # http://localhost:5173 (proxies /api to the service)
```

Open the app, pick a thread, send a message. The placeholder transcript counts frames — replacing it is the assignment. Start with `welcome`: it is the smallest thread and the quickest way to see a first render. The rest are real conversations and several are large.

We ask for git history, so `git init` and commit this starter untouched before you begin — it gives you, and us, a clean base to read your work against.

## Notes

- `app/src/api/client.ts` gives you raw SSE frames (`StreamFrame`). Decoding them and everything above that is yours.
- `app/src/api/types.ts` has the v2 wire types. The legacy protocol is described in `PROTOCOL_V1.md`.
- You may restructure anything in `app/` — the shell is a starting point, not a constraint.
- `npm test` runs `vitest` in either package. `app/src/fixture.test.ts` shows how to read a fixture straight off disk, which is the cheapest way to test a reducer: no server, no network, and the hostile cases are already written down.
