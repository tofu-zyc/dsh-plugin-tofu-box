# dsh-plugin-pvz-perf — design & build contract

Status: v0.1 build contract for the two builder agents. The Lead owns
`package.json`, `cordis.patch.yml`, locale resources, icon, README, gitignore and
all verification/install steps. Builders never touch those files.

## 1. Goal

A DSH Web UI plugin that lets the user play the **pvz_perf web build** (already on
disk at `E:\Games\pvz_perf_web`, v3.3.4, WebGPU + WebGL2 wasm build) inside the
Harness page. The plugin must not ship or copy game assets: the Host half serves
them from a local directory over a loopback HTTP route on the existing Harness web
server, and the Browser half embeds that route in a full-screen overlay.

Non-goals for v0.1: launching the native `pvz_perf.exe`, downloading/updating the
game from GitHub, save-file editing, agent tools, persistence beyond the game's own
IndexedDB.

## 2. Fixed names (do not change without telling the Lead)

| Item | Value |
| --- | --- |
| package name / locale namespace / loader id | `dsh-plugin-pvz-perf` |
| patch row id | `pvz-perf` |
| Host route prefix | `/pvz-perf` |
| Game page URL | `/pvz-perf/game/` (the iframe src) |
| Status endpoint | `/pvz-perf/status` |
| Sidebar panellist id + main panel key | `pvz-perf` (same string for both) |
| Overlay seat id | `pvz-perf.game-overlay` |
| Footer action seat id | `pvz-perf.launch` |

The client also hardcodes the route prefix in its own module (it cannot import
Host code); keep the two literals identical and assert them in tests.

## 3. Host half — `index.js` (owned by host-builder)

Plain ESM, Node builtins only (`node:fs`, `node:fs/promises`, `node:path`,
`node:http` types are not imported). No schemastery, no Config export, no runtime
dependencies. Header comment explains the design.

Exports:

- `export const name = 'dsh-plugin-pvz-perf'`
- `export const inject = ['webServer']`
- `export function apply(ctx)` — resolves the game dir, registers one route with
  `ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'pvz-perf: game route')`,
  logs one `ctx.logger.info(...)` line with the resolved directory/version (or a
  warning when not found), never throws when the game is missing.
- Pure helpers, exported for `node --test`:
  - `export const ROUTE = '/pvz-perf'`
  - `export const GAME_PREFIX = '/pvz-perf/game'`
  - `export const CANDIDATE_SUFFIXES` — array of path suffixes appended to each
    drive/user-profile root, e.g. `Games\pvz_perf_web`, `Games\pvz_perf`,
    `pvz_perf_web`, `Downloads\pvz_perf_web` (Lead may extend).
  - `export function readManifest(gameDir)` → `{ version, sourceCommit, backend } | null`
    (reads `web-build-manifest.json`; missing/malformed → null, never throws).
  - `export function isGameDir(dir)` → boolean: true only when `index.html` and
    `web-build-manifest.json` exist as files and at least one of
    `launcher.js` / `pvz-perf.js` exists (sync `fs` is fine here).
  - `export function resolveGameDir({ env = {}, candidates } = {})` →
    `{ dir, version, sourceCommit } | null`. Order: `env.DSH_PVZ_GAME_DIR`,
    `env.PVZ_PERF_WEB_DIR`, then each candidate; `candidates` defaults to a list
    built from every existing drive root `X:\` (C–H) + `%USERPROFILE%` ×
    `CANDIDATE_SUFFIXES`. First valid wins.
  - `export function mimeTypeFor(filePath)` → content type string; map at least
    `.html .js .mjs .css .json .wasm .gz .data .svg .png .ico .txt .woff2 .mp3 .ogg .wav`;
    unknown → `application/octet-stream`. `.wasm.gz` → `application/gzip`.
  - `export function gameRelativePath(urlPathname)` → `string | null`: map a
    pathname under `/pvz-perf/game` to a safe relative path (`''` means
    `index.html`); return null for anything unsafe (encoded traversal, `\`,
    absolute, NUL, `..` segment).
  - `export function createGameHandler(options)` → `async (req, res) => void`.
    `options = { resolve: () => resolvedGameDirOrNull }`; the handler re-resolves
    lazily and caches, retrying on each request while null.
- `apply` wires `createGameHandler({ resolve: () => resolveGameDir() })`.

Route contract (the handler owns all of this):

| Request | Response |
| --- | --- |
| `GET /pvz-perf/status` | `200 application/json`: `{ ok, dir, version, sourceCommit, gameUrl: '/pvz-perf/game/', hint }`; `ok:false` + `dir:null` + `hint` when the build is missing. Never 404. |
| `GET/HEAD /pvz-perf/game`, `/pvz-perf/game/…` | The file's bytes, `content-type` from `mimeTypeFor`, `content-length`, `cache-control: no-store`, `x-content-type-options: nosniff`; `/game` and `/game/` serve `index.html`. |
| `GET /pvz-perf/game/<missing>` | `404 text/plain; charset=utf-8` |
| Path under `/game` that resolves outside the game dir | `400 text/plain` (traversal) — never read outside |
| Other method on the game route | `405` + `allow: GET, HEAD` |
| Any other path under `/pvz-perf` | `404 text/plain` |
| Any game request while no build is found | `200 text/html` with the embedded `HELP_HTML` page (Chinese + English) explaining what to install and the env override, so the iframe shows instructions instead of a blank error |
| Uncaught error | `500 text/plain` and a `ctx.logger.warn` from `apply`'s wrapper is not required; handler must not crash the server |

Serving uses `fs.promises.stat` + `fs.createReadStream`; HEAD sends headers only.
The game directory may be large (42 MB) — never buffer whole files.

Security note in comments: routes are read-only and loopback-bound; do not serve
anything outside the resolved game dir; no directory listings.

Tests — `tests/host.test.mjs` (`node --test`, no deps):

- mime map, manifest parse, `isGameDir` positive/negative.
- `gameRelativePath`: accepts `index.html`, `audio/music-worklet.js`, `/game/`
  → `index.html`; rejects `%2e%2e%2fsecret`, `..\secret`, `//abs`, `a\b`,
  `a/%2e%2e/b`, NUL.
- `createGameHandler` against a real `node:http` server on `127.0.0.1:0` and real
  fixtures in `tests/fixtures/` (own this directory):
  - fixture game dir with `index.html`, `web-build-manifest.json`, `launcher.js`,
    `sub/asset.bin`, plus `secret.txt` **outside** it;
  - status 200 JSON with version; `ok:false` payload from a resolver returning null;
  - `GET /pvz-perf/game/index.html` 200 + HTML body + headers;
  - `/game/` serves index; `HEAD` has content-length and empty body;
  - traversal attempt does not leak `secret.txt`;
  - missing file 404; POST 405; empty resolver → 200 help page containing
    `DSH_PVZ_GAME_DIR` and `pvz_perf_web`;
  - stop the server in `after()` and remove any temp files.

## 4. Browser half — `client.js` (owned by client-builder, i.e. the Lead)

`window.__ModuleLoader__.load({ id: 'dsh-plugin-pvz-perf', factory(require) { … return plugin } })`.
Only `require('react')`. Plugin shape:

```js
{ inject: ['slots', 'locale'], apply(ctx) { … } }
```

`apply` must use `ctx.effect` for every resource: the injected `<style>` element,
the locale dictionaries, the store's subscriptions, and the four seat
registrations, each through `ctx.slots.inject(name, () => ctx.slots.register(entry, Component))`.
`ctx.get('layout')` is optional (`layout.selectPanel(id)`).

### Store (module closure, `__test` seam)

`createGameStore({ fetchStatus })` where `fetchStatus` defaults to a real fetch of
`ROUTE + '/status'`. Snapshot is a frozen plain object:

```js
{
  phase: 'idle' | 'loading' | 'ready' | 'missing' | 'error',
  info: null | { dir, version, sourceCommit, gameUrl },
  error: null | string,
  opened: false,   // game layer has ever been opened (drives mount of the iframe)
  visible: false,  // overlay currently shown; false + opened = backgrounded
  reloadKey: 0,    // incremented by 重新载入 to remount the iframe
}
```

Actions: `refresh()`, `open()` (opens + refreshes when info is stale/missing),
`hide()`, `show()`, `toggle()`, `reload()`, `close()` (opened=false; unmounts the
iframe). `subscribe(fn)` / `getSnapshot()` return the same snapshot reference until
a change. Tests drive a fake `fetchStatus`.

### Seats

1. `sidebar.panellist` — `{ name: 'sidebar.panellist', id: 'pvz-perf', order: 26, label: () => t('panel.title') }`,
   component renders the 9×9 pixel potted-plant glyph (`G` leaf `#5cb968`,
   `P` pot `#b06a3b`, `.` transparent; 16px default, `props.active` adds a thin
   outline) as inline SVG; shell owns the button and dispatches the panel switch.
2. `main` keyed `{ name: 'main', key: 'pvz-perf' }` — the hub panel: a themed
   card with the plugin title, game state chip (就绪 / 未找到 / 检查中 / 出错),
   version + directory lines, primary button `开始游戏`/`继续游戏` (calls
   `open()`), secondary buttons `重新检查` (refresh), `返回对话`
   (`layout.selectPanel('conversation')`, hidden when layout is absent), and a
   help section that always lists: expected directory, env override
   `DSH_PVZ_GAME_DIR`, and the game-version requirement (pvz_perf web build
   v3.3.x with `web-build-manifest.json`). When phase is `missing`/`error` the
   help section is expanded and the primary button is disabled.
3. `shell.overlay` — `{ name: 'shell.overlay', id: 'pvz-perf.game-overlay', order: 900 }`,
   component renders `null` until `opened`; afterwards a fixed, full-frame layer
   (`position: fixed; inset: 0; z-index: 9999; pointer-events: auto`) that is
   `display: none` when `visible === false` (so the iframe keeps running in the
   background). Its 34px header carries the title, a status dot, and buttons:
   `隐藏` (hide), `全屏` (requestFullscreen on the layer element), `重新载入`
   (reload), `结束` (close, unmounts the iframe — tooltip warns progress is only
   saved on a normal in-game quit), `回到对话` when layout exists. The iframe
   `src = ROUTE + '/game/'`, `title` from locale, `allow = 'fullscreen; autoplay; gamepad; clipboard-write'`,
   `allowFullScreen`, `style = { border: 0, width: '100%', height: '100%', display: 'block', background: '#000' }`,
   `key = 'pvz-' + reloadKey`.
4. `sidebar.footer.action` — `{ name: 'sidebar.footer.action', id: 'pvz-perf.launch', order: 42 }`,
   component receives owner prop `{ wide }`: a 28px icon button, label text only
   when `wide`, `title`/`aria-label` from locale; click = `toggle()` (opens the
   overlay when closed, hides/shows when already opened). Styled with theme tokens.

Also: `Suspense`-free plain components; an error boundary class around the hub and
overlay (fall back to a plain message + the error stack in a `<pre>`); no DOM writes
except the injected `<style>` (return cleanup); all class names `pvz-` prefixed;
colors only via `--dsw-alias-*` tokens except the glyph art; nothing imports
`@deepseek-ai/*`; no `document.body` appends; no `setInterval` without effect
cleanup (ideally none).

Locale dictionaries registered at apply time (zh + en) with at least:
`panel.title`, `hub.title`, `hub.subtitle`, `hub.state.idle/loading/ready/missing/error`,
`hub.start`, `hub.resume`, `hub.refresh`, `hub.back`, `hub.dir`, `hub.version`,
`hub.help.title`, `hub.help.dir`, `hub.help.env`, `hub.help.version`,
`overlay.hide`, `overlay.fullscreen`, `overlay.reload`, `overlay.close`,
`overlay.closeHint`, `overlay.back`, `footer.toggle`, `error.boundary`.
The exported `locale/*.json` files only carry `meta.*` (Plugin Manager display);
UI strings live in these inline dictionaries.

Test seam: `module.exports.__test = { ROUTE, PANEL_ID, createGameStore, SEATS }`
(`SEATS` = the four seat descriptors) so `node --test` can assert the contract.
`tests/client.test.mjs` boots the bundle with a fake `window.__ModuleLoader__` and
fake React (see `dsh-plugin-pixel-ecosystem/tests/_harness.mjs` for the proven
pattern; copy what you need, do not import it). Cover: 4 seats with exact
names/ids/keys/order, store transitions (open/hide/show/toggle/reload/close,
missing status), overlay renders an iframe with `src === '/pvz-perf/game/'` and
toggles `display`, hub shows version/dir and help when `missing`, locale `en` and
`zh` dictionaries both exist and every `t('key')` used by the components resolves
in both (fail on missing key), only `require('react')` is requested.

## 5. Shared rules for both builders

- Write only your owned files (host-builder: `index.js`, `tests/host.test.mjs`,
  `tests/fixtures/**`; client-builder: `client.js`, `tests/client.test.mjs`,
  `tests/_client_harness.mjs`). Do not edit `package.json`,
  `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README.md`, `DESIGN.md`,
  other plugins, or the game directory.
- Run `node --check <file>` and `node --test tests/<own>.test.mjs` before reporting
  done. Tests must pass in the workspace sandbox with no network access.
- No new npm dependencies; no `.ts`; no build step. Node ESM, 2-space indent,
  JSDoc on exported functions, English code comments (Chinese is fine for user
  copy inside locale dictionaries and comments explaining game-version quirks).
- Do not start `dsh`, do not install anything into any profile, do not write
  outside the plugin directory (except the `.probe/` scratch dir for the prober).
- Report back: files written, test command + result, assumptions/risks, and any
  contract deviation. The Lead integrates and verifies; do not claim the plugin
  works end to end.

## 6. Layout revision after the first real-machine round (0.1.1)

The 0.1.0 design put the game into `shell.overlay`, a root-scoped full-window
layer. On the real desktop shell that was wrong twice over:

- it covered the whole window, sidebar included, which is not the surface the
  user expects a plugin panel to use;
- the overlay bar ran to the right window edge, so its last two actions
  (`回到对话`, `结束`) were painted underneath the desktop window buttons and
  could neither be seen nor clicked — the round became impossible to leave.

0.1.1 therefore moves the game inside the `main` panel the shell already
allocates to this plugin. Seats are now:

| Seat | Id / key | Content |
| --- | --- | --- |
| `sidebar.panellist` | id `pvz-perf`, order 26 | potted-sprout icon, opens the panel |
| `main` | key `pvz-perf` | hub when closed; game + compact tool bar when open |
| `sidebar.footer.action` | id `pvz-perf.launch`, order 42 | selects the panel and starts the game |

There is no `shell.overlay` registration, no `position: fixed`, and no z-index
above the app chrome. The game tool bar is `返回对话 / 全屏 / 重新载入 / 结束`;
"back" hands the central column back to the conversation (the game page unmounts
with the panel, and the game only writes a level back on a normal in-game quit).
Fullscreen is an explicit user action on the panel element only.

Verification for this revision: rc-dev web instance, real headless Chrome —
game rect starts at x=280 (sidebar occupies 0..280), computed position `static`,
zero fixed full-window layers, all four tool-bar buttons present, the iframe
loads the pvz_perf launcher and "返回对话" returns to the conversation.

## 7. Toolkit lineup import (0.1.3)

The web build's Custom Save → 布阵与关卡 picker reads `pvz_custom_lineups` from the
game origin's localStorage. The standalone PvZ Toolkit keeps a 339-entry list in
`setups.yml` next to its exe. 0.1.3 adds a one-way convenience import:

- Host: `findToolkitSetups()` resolves `DSH_PVZ_TOOLKIT_DIR` / `PVZ_TOOLKIT_DIR`,
  `PvZ_Toolkit*` folders next to the game build, drive `\Games` folders, then the
  user's Games folder; `parseToolkitSetups()` parses the Toolkit's documented YAML
  subset and normalises codes exactly like the game's `decodeLineup` (URL-safe →
  Base64, padding restored). `GET /pvz-perf/toolkit/lineups` returns
  `{ ok, file, count, skipped, version, lineups }`, re-read at most every 5 s.
- Browser: `mergeToolkitLineups()` dedupes by code and preserves the user's names;
  `importToolkitLineups()` writes `pvz_custom_lineups` plus a marker of the codes
  this plugin added; `clearToolkitLineups()` removes only those. `apply()` runs the
  import once per Toolkit version on activation; the hub card can re-run it and
  clear it. Same-origin plugin page and game iframe share that storage, so no game
  UI automation is needed.
- Verified on the rc-dev web instance: route returned 339/339 codes from
  `E:\Games\PvZ_Toolkit_v1.22.0\setups.yml`, the plugin auto-imported all 339, and
  the game's own Custom Save lineup picker then listed 343 options (4 built-ins +
  339 imported).
