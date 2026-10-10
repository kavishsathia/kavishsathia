# PlusCal & TLC in the browser — the build

The `/tools/pluscal` page runs the TLA+ tools client-side. This directory
holds everything needed to rebuild what it ships; the outputs are committed
under `public/pluscal` (the site's deploy environment has no JDK).

## What runs

- **`tla2tools.jar`, unmodified**: the TLA+ project's own distribution. It
  holds the PlusCal translator (`pcal.trans`), the SANY parser, and the TLC
  model checker. It's the nightly (the `v1.8.0` release tag is re-published
  continuously), pinned by SHA-256 to rev `94d0c50` of 2026-10-06.
- **The TLA+ Community Modules** (`CommunityModules.jar`,
  `CommunityModules-deps.jar`), release `202610040242`, pinned by hash.
  `tla2tools.jar`'s manifest lists them on its `Class-Path`, as every TLA+
  distribution ships them, so `EXTENDS SequencesExt` etc. work, with their
  Java overrides.
- **CheerpJ 4.3** (Leaning Technologies) as the JVM, Java 11 mode (the jar's
  bytecode level).

## The glue

Two small jars, built by `build.sh`:

- `pluscal-web.jar`, the `site.pluscal.PlusCalWeb` facade JavaScript calls
  through CheerpJ's library mode. For every request it creates a **fresh
  classloader** over `tla2tools.jar` and the runner. The translator and TLC
  keep their state in statics and were written to run once per process, so
  this is what makes run N+1 independent of run N. Spec files live in
  CheerpJ's writable `/files/` mount; each run gets its own directory
  (including TLC's `-metadir`).
- `pluscal-runner.jar`, `site.pluscal.runner.PlusCalRunner`, loaded inside
  that classloader. It does what `pcal.trans.main` and `tlc2.TLC.main` do,
  minus `System.exit`. The translator runs in `ToolIO.TOOL` mode, so it
  returns a status and keeps its messages. TLC gets `-tool`, the
  message framing the Toolbox and VS Code parse, and its output stream is
  routed line by line to a JavaScript native (`emit`).

Two runtime details, both on the JavaScript side (`src/lib/pluscal/engine.ts`):

- **Stopping.** CheerpJ runs one call from JavaScript at a time, so the
  page can't call `stop()` while `check()` is running. A watchdog thread
  in the facade polls a JavaScript native (`stopRequested`) every 200 ms
  and calls `TLCGlobals.mainChecker.stop()`, the Toolbox's stop.
- **Missing intrinsics.** CheerpJ 4.3 lacks `jdk.internal.misc.Unsafe`'s
  `fullFence`/`loadFence`/`storeFence`; TLC reaches them through
  `VarHandle` fences (e.g. the Community Modules' `FoldSet`). They're
  supplied as no-op natives: Java threads on CheerpJ are green threads on one
  JavaScript thread, so a fence has nothing to order.

**No telemetry.** TLC can report anonymous execution statistics. It only does
so when `~/.tlaplus/esc.txt` opts in. The facade writes the documented
opt-out (`NO_STATISTICS`) there anyway, and the e2e test asserts the page
makes no requests beyond its own origin and CheerpJ's CDN. (Note: setting
`-Dutil.ExecutionStatisticsCollector.id` does *not* opt out. TLC uses that
value as the installation id.)

## Rebuilding

```sh
./build.sh                              # fetch + verify the pinned jars, build the glue, run JvmCheck
node check-examples.mjs                 # every example on the page, through the real jar, vs its expected exit status
```

`build.sh` needs a JDK 11+ and curl; downloads land in `.work/` (gitignored).
`JvmCheck` drives the facade the way the page does: translation, a passing
model, an invariant violation with a trace, a deadlock, a translator error, a
SANY error, the Community Modules, back-to-back runs, and stop. It runs with
its own `user.home`, so it doesn't touch your `~/.tlaplus`.

The browser side is covered by `tests/e2e/pluscal.spec.ts` and the output
parser by `src/lib/pluscal/tlcOutput.test.ts`, which reads real `-tool`
output captured from this jar (`src/lib/pluscal/fixtures/`).

## Limits

One TLC worker (CheerpJ's threads share one JavaScript thread), and roughly
2–3k distinct states per second. That's plenty for the models you write while
thinking, not for large ones. The page stays responsive while TLC runs (CheerpJ
yields), and the heap is CheerpJ's (TLC reports 2 GB).
