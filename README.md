# StarDust — website

Landing page for [StarDust](https://github.com/damarbob/StarDust), a MySQL-native
Vertical Schema Partitioning engine for dynamic data models.

The engine is abstract — most of what makes it interesting happens in background
daemons, over time, in tables nobody sees. So the page is built around four
interactive demonstrations rather than prose:

| Section | What it shows |
| :-- | :-- |
| `components/SlotMirror.tsx` | Edit a payload, flip fields between filterable and JSON-only, and watch values mirror into typed indexed slot columns — then see what a filter on each field actually costs. |
| `components/JoinSwamp.tsx` | An illustrative cost model of EAV join fan-out against StarDust's fixed single-page join, as the number of filter conditions grows. |
| `components/FieldLifecycle.tsx` | The promotion window: `promoteFieldToFilterable()` returns → the Watcher provisions a page → the Reconciler claims the slot and backfills → it flips to `ready`, with a live NDJSON event stream. Mirrors `examples/01-field-lifecycle.php` in the engine repo. |
| `components/DaemonBoard.tsx` | All four daemons running on their own poll periods, coordinating only through shared MySQL state. |

## The playground

`/playground` ([`app/playground/`](app/playground/),
[`components/playground/`](components/playground/)) is a second route: one
continuous world where the schema you define produces the rows you write, which
produce the index the daemons build. Unlike the four sections above, which each
reset on their own and share nothing, every part of it reads the state the
previous part produced — so it needs a persistent world with a clock, which is
what [`lib/sim/`](lib/sim/) is.

**It is a simulation and says so on the page.** There is no Node runtime, no PHP
and no MySQL in production, so it cannot run the real engine. The rules were
written by hand to match; where the two disagree, the engine is right.

Two conventions hold that honesty in place, and both are cheaper to keep than to
restore:

- **Engine semantics live only in `lib/sim/`.** No component encodes a rule about
  slots, statuses or daemons. If a component needs to know whether a filter would
  be rejected, it asks the core.
- **Event names are a closed union.** [`lib/sim/events.ts`](lib/sim/events.ts)
  mirrors the engine's own closed vocabulary, so an invented event name is a
  `npm run typecheck` failure rather than a plausible-looking string in a log
  panel. It is a checked-in copy — the engine is a separate repository and
  nothing here can verify it — so when the engine adds an event, add it there in
  the same change.
- **Reducers are pure.** No `new Date()`, no `Math.random()`, no module-level
  counters: timestamps come from `simNow(world)` and ids from `world.seq`.
  React StrictMode double-invokes reducers, so anything else builds a different
  world in development than in production — and a random seed generator would
  produce rows the event log then describes wrongly.
- **Where the simulation is narrower than the engine, it says so on the page.**
  The datetime parser takes ISO 8601 and `Y-m-d H:i:s`; the engine hands the
  value to PHP's `DateTimeImmutable`, which also accepts `tomorrow` and reads a
  naked string in the *server's* timezone. Reproducing that in a browser would
  mean guessing at a server configuration and rendering the guess as fact, so
  it is a documented subset instead.
- **Where the simulation is *wider* than the engine — because the engine has a
  bug — it says so at the line that causes it.** There is exactly one, and it is
  the only kind of divergence that needs naming rather than merely documenting:
  the simulation resets `sweep_cursor_id` when a slot is tombstoned, and the
  engine does not, so a recycled slot column's second sweep skips every row
  below the first sweep's final cursor. Reproducing it faithfully would make the
  playground's reclaim demo teach a defect. The comment in
  [`lib/sim/reserve.ts`](lib/sim/reserve.ts) is what stops it being quietly
  "corrected" back to match; when the engine fixes it, delete the comment rather
  than the line.
- **The schema is quoted, not paraphrased.** [`lib/sim/ddl.ts`](lib/sim/ddl.ts)
  holds each `CREATE TABLE` verbatim from the engine's bootstrap runner, and the
  playground puts it one click from the rows so the "these are the engine's
  columns" claim is checkable. Same duty as `events.ts` and rather less
  forgiving: a stale event name fails a build, a stale `CREATE TABLE` just looks
  right. When the engine's schema changes, change it there in the same commit.

Build sequencing lives in [`PLAYGROUND_ROADMAP.md`](PLAYGROUND_ROADMAP.md).

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck
npm run build      # static export into out/
```

Requires Node 20+ (CI uses 22).

Don't run `npm run build` while `npm run dev` is up — they share `.next/`, and
the build overwrites the running server's webpack runtime, which turns every
request into a `MODULE_NOT_FOUND` 500. Stop the dev server first, or delete
`.next/` and restart it if you already have.

## Build

There is **no Node runtime in production**. `npm run build` produces `out/`, a
self-contained folder of static files that any static host can serve.

```bash
npm ci
npm run build          # → out/
```

Publishing is putting the **contents** of `out/` at the web root.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) typechecks and builds on
every push and attaches `out/` as a downloadable **`site`** artifact, so a
release never requires building locally. It deliberately does not deploy —
that would mean putting host credentials in repository secrets, which is a
decision to make on purpose rather than inherit from a template.

Three settings exist for the sake of static hosting, and are easy to break by
tidying:

- **`trailingSlash: true`** in [`next.config.mjs`](next.config.mjs) emits each
  route as `<route>/index.html`, which a plain file server resolves through its
  normal index lookup. Turn it off and routes 404 unless the visitor types
  `.html`.
- **No `basePath`** — the site is served from the domain root. Set one only if
  it moves into a subdirectory.
- **[`public/.htaccess`](public/.htaccess)** ships alongside the build, since
  Next copies dotfiles from `public/`. On Apache-family hosts it wires up the
  exported 404 page, forces HTTPS, and caches the content-hashed
  `_next/static/` bundles for a year while holding HTML at `must-revalidate` —
  that pairing is what makes a redeploy take effect immediately rather than
  after a cache expiry. Other hosts ignore the file; configure the equivalent
  there.

`SITE_URL` in [`lib/links.ts`](lib/links.ts) is the canonical origin used for
the canonical link and Open Graph tags. Those must be absolute, and a static
export has no request to derive a host from, so it is stated there and nowhere
else — update that one constant if the domain changes.

## Conventions

- **No CSS framework.** Design tokens live at the top of [`app/globals.css`](app/globals.css);
  everything else is CSS Modules. The colour ramp is load-bearing, not decorative —
  teal means *indexed*, amber means *pending/backfilling*, rose means *rejected or
  tombstoned*, and neutral slate means *JSON-only: stored, and never mirrored by
  design*. Keep that mapping if you add a demo — the last two are the pair most
  easily confused, and colouring a JSON-only value as a failure teaches the
  opposite of what the engine does.
- **No animation library.** Transitions are CSS; the value-in-flight ghosts are the
  Web Animations API over measured DOM rects ([`lib/fly.ts`](lib/fly.ts)).
- **Every demo honours `prefers-reduced-motion`** by jumping to a settled end state
  rather than by animating faster. The end state is the lesson.
- **URLs live in [`lib/links.ts`](lib/links.ts), never in a component.** That
  module has no `'use client'` on purpose: a constant exported from a client
  module arrives at a server component as a client-reference stub, and while a
  bare `href={REPO}` survives it, `` `${REPO}/issues` `` stringifies the stub's
  source code into the href and ships a broken link. This already happened once.
- **Claims about the engine must match the engine.** Event names in the log stream
  come from StarDust's closed ADR 0020 vocabulary, and the numbers in `JoinSwamp`
  are labelled on the page as an illustrative model rather than a benchmark. If a
  claim here and the engine's README ever disagree, the engine wins.

## License

MIT — see [LICENSE](LICENSE).
