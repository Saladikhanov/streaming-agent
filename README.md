# Streaming Agent Console

A transcript for live AI-agent activity. Frames arrive over SSE one at a time; the transcript
they reduce to is hierarchical — text assembles from hundreds of deltas, tool calls collapse
into groups, and sub-agents nest inside the action that delegated to them.

Built against the contract in [`docs/BRIEF.md`](docs/BRIEF.md).

## Run it

Node 20.19+ or 22+ (`.nvmrc` pins 22). Two terminals:

```sh
cd server && npm ci && npm start     # http://localhost:8787
cd app    && npm ci && npm run dev   # http://localhost:5173
```

Open the app, pick a thread, send a message. `Getting started` is the smallest; `Q3 launch
review` shows a sub-agent; `ROAS reality check` is a legacy v1 thread that migrates to v2
mid-stream.

| | |
|---|---|
| Install | `npm ci` in `app/` and `server/` |
| Develop | `npm run dev` (app) · `npm start` (server) |
| Test | `npm test` in either package |
| Typecheck | `npm run typecheck` (app) |
| Production build | `npm run build` (app) |

**`npm ci`, not `npm install`.** Both lockfiles carry `libc` fields on the Linux native
optional dependencies; an older npm strips all 32 when it rewrites a lockfile, which leaves
an Alpine or CI build unable to tell a glibc binary from a musl one.

The service replays at real time. `MOCK_SPEED=20 npm start` is easier to develop against, but
some behaviour only shows at `1` — Stop in particular, which at 20× finishes before you can
click it.

## What it does

- **Streams** Markdown, reasoning, tool calls, tables and files, updating as frames arrive
- **Nests sub-agents** at arbitrary depth, including when their frames arrive before the
  action that opens their scope
- **Distinguishes** loading, empty, completed, stopped, interrupted and error states — an
  action still running when a connection drops is *interrupted*, never *failed*
- **Follows the stream** only while you are at the bottom, with one action to catch up
- **Locks the composer** while a question is pending; answers submit as a single turn and
  survive reopening the thread
- **Renders legacy v1 threads** through the same presentation model — the chosen extension

## Layout

```
app/src/transcript/   the transcript: decoding, reduction, placement, rendering
app/src/i18n.ts       interface strings, loaded from app/public/locales/en.json
server/               mock service, unchanged from the starter
fixtures/             16 recorded conversation streams
docs/                 the contract, the design, and the decision log
```

Everything below `useTranscript` is a pure function, which is why the tests replay recorded
streams off disk with no server, no network and no DOM.

## Tests

```sh
cd app && npm test        # 102 tests
cd server && npm test     #  13 tests, unchanged from the starter
```

Organised by section of the contract, each quoting the clause it enforces. All 16 recorded
streams are replayed with invariants asserted, and the rendering contract is checked as HTML
without a DOM.

## Documentation

| | |
|---|---|
| [`docs/BRIEF.md`](docs/BRIEF.md) | The behaviour contract, transcribed verbatim |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Architecture, state model, supersession, visual hierarchy, omissions |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why each choice was made, and what was rejected |
| [`PROTOCOL_V1.md`](PROTOCOL_V1.md) | The legacy protocol |
| [`server/README.md`](server/README.md) | The mock service and its fixtures |

`DECISIONS.md` includes the calls that were wrong first time — four defects only a real
browser exposed, and an artifact allowance read too broadly.
