# StarDust — website

Landing page for [StarDust](https://github.com/damarbob/stardust), a MySQL-native
Vertical Schema Partitioning engine for dynamic data models.

The engine is abstract — most of what makes it interesting happens in background
daemons, over time, in tables nobody sees. So the page is built around four
interactive demonstrations rather than prose:

| Section | What it shows |
| :-- | :-- |
| `components/SlotMirror.tsx` | Edit a payload, flip fields between filterable and JSON-only, and watch values mirror into typed indexed slot columns — then see what a filter on each field actually costs. |
| `components/JoinSwamp.tsx` | An illustrative cost model of EAV join fan-out against StarDust's fixed single-page join, as the number of filter conditions grows. |
| `components/FieldLifecycle.tsx` | The promotion window: `promoteFieldToFilterable()` returns → Watcher provisions → Reconciler backfills → the slot flips to `ready`, with a live NDJSON event stream. Mirrors `examples/01-field-lifecycle.php` in the engine repo. |
| `components/DaemonBoard.tsx` | All four daemons running on their own poll periods, coordinating only through shared MySQL state. |

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

## Deploy

`npm run build` produces a fully static `out/` — no Node runtime in production.
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) publishes it to
GitHub Pages on every push to `main`.

The workflow sets `NEXT_PUBLIC_BASE_PATH=/StarDustWebsite` because the default
Pages URL is a subpath. **When a custom domain is attached, drop that env var**
or every asset URL keeps the now-wrong prefix.

## Conventions

- **No CSS framework.** Design tokens live at the top of [`app/globals.css`](app/globals.css);
  everything else is CSS Modules. The colour ramp is load-bearing, not decorative —
  teal means *indexed*, amber means *pending/backfilling*, rose means *rejected or
  tombstoned*. Keep that mapping if you add a demo.
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
