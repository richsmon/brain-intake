# brain-intake — brain-host API

Server half of the universal-brain **companion** (IN-2): capture up, events
down. A thin HTTP layer over the brain's `inbox/` contract — no inference here;
classification and routing stay in the brain's intake loop
(`tools/brain-loop/run.py`).

Contract source of truth: `inbox/README.md` in the brain repo (IN-1). Item ids,
`events.jsonl` semantics and the event vocabulary in this codebase mirror it and
must never drift — the contract doc is the single arbiter.

## Run

```sh
BRAIN_ROOT=/path/to/universal-brain npm start
```

| env | default | meaning |
|---|---|---|
| `BRAIN_ROOT` | (required) | brain repo checkout; must contain `inbox/` |
| `PORT` | `8787` | listen port |
| `BIND` | `127.0.0.1` | listen address — set to the host's Tailscale IP to reach it from the phone |

Security boundary is the tailnet: there is no app-level auth. Do not bind to a
public interface.

## Endpoints

| method + path | body | result |
|---|---|---|
| `GET /health` | — | `{ok, brainRoot}` — the app's reachability probe |
| `POST /items` | JSON `{source: "text"\|"share-sheet", text, originalName?, deviceTs?}` | `201 {id, deduped}` |
| `POST /items` | multipart: `file` + fields `source` (`voice`\|`photo`), `deviceTs?` | `201 {id, deduped}` |
| `GET /items` | — | `[{id, state, lastEvent, title?}]` |
| `GET /items/:id` | — | `{id, state, events, payload: {name, bytes}}` |

Capture is idempotent by content hash: re-posting the same payload returns the
existing item id with `deduped: true` (safe for the app's offline-queue retries).
Upload cap 25 MB; extensions `jpg|jpeg|png|heic|m4a|mp3|wav`.

## Smoke

```sh
BRAIN_ROOT=... PORT=8787 ./scripts/smoke.sh
```

Drives health → text capture → list → detail against a running server.

## Develop

```sh
npm test        # vitest
npm run typecheck
npm run lint
```

## Mobile app (`mobile/`)

Expo app ("Brainer") — the capture + read surface over this API. Offline-first:
captures queue on-device (`queue/<uuid>/meta.json + payload`) and flush when the
brain-host answers `/health`; entries are removed only after a `201`, so retries
are safe thanks to the server's sha-dedupe.

```sh
cd mobile
npm test           # jest (jest-expo + RNTL)
npx tsc --noEmit   # strict typecheck
npx eslint .
npm run ios        # simulator dev run (prebuilds native incl. share extension)
```

Capture sources: text note, photo (camera/library), voice (m4a), iOS share
sheet (web URLs / text / images — `expo-share-intent` extension target).
Configure the brain-host URL in the in-app Settings (⚙️); default points at the
Tailscale tailnet IP. Distribution: TestFlight Internal Testing via the native
xcodebuild pipeline (see the brain repo's TF runbook notes).
