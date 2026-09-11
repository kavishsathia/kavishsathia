# CEL verifier in the browser — the build

The `/tools/cel` page runs Google's formal verification framework for the
Common Expression Language client-side. This directory holds everything
needed to rebuild what it ships; the outputs are committed under
`public/cel` (the site's deploy environment has neither a JDK nor Emscripten).

## What runs

- **cel-java 0.14.0's `verifier` package**, compiled from its sources at the
  release tag with no changes (the release has no published artifact yet).
  The REPL's core classes come along so the page mirrors the CLI's compiler
  setup exactly; the picocli/jline REPL itself is left out.
- **CheerpJ 4.3** (Leaning Technologies) as the JVM. It runs the assembled
  jar as-is — protobuf-java, ANTLR, Guava, snakeyaml — and lets Java `native`
  methods be implemented in JavaScript, which is how Z3 is reached.
- **Z3 4.14.1**, the version cel-java pins through `z3-turnkey`, compiled to
  wasm here (`build-z3.sh`) as a *single-threaded* build with Z3's polling
  timer so solver timeouts still work without threads.

## How Z3 is reached

`com.microsoft.z3.Native` has ~780 JNI methods, one per Z3 C entry point,
generated from the `def_API(...)` declarations in Z3's headers.
`gen-z3-natives.mjs` parses those same declarations into
`src/lib/cel/z3natives.json`; `src/lib/cel/z3bridge.ts` reads that table and
produces one CheerpJ native per entry that marshals arguments into wasm
memory and calls the matching `_Z3_*` export. `check-sigs.mjs` verifies the
table against `javap -p` of the real `Native` class (the eight user-propagator
callbacks are the only entry points deliberately not bridged).

Two small pieces of glue:

- `stub/.../TurnKey.java` replaces z3-turnkey's native-library loader with a
  no-op (the natives don't come from a library).
- `z3-shim.cpp` installs a do-nothing Z3 error handler, so errors surface via
  `Z3_get_error_code` — which the generated Java wrappers check after every
  call — rather than Z3's default handler aborting the process.

`src/.../CelVerifierWeb.java` is the JS-facing facade: it lives in the tools
package to reuse `CelVerifierToolCore` and `VerificationOptions`, and wraps
results in JSON.

## Rebuilding

```sh
./build.sh                                   # jar + bridge table (JDK 11+, node)
./build-z3.sh <z3 checkout at z3-4.14.1> <emsdk dir> ../../public/cel
```

`build-z3.sh` needs Emscripten (tested with 6.0.9) and takes ~25 minutes on
an M-series Mac. Everything `build.sh` downloads lands in `.work/`.

## Why no cross-origin isolation

The other tools share a threaded Z3 build, which needs SharedArrayBuffer and
so COOP/COEP headers. CheerpJ's runtime fetches its files through a helper
iframe on its CDN, and a COEP page cannot embed that frame. Hence the
thread-less Z3 build: this page runs with no isolation headers at all.

## Known limitations

- Everything is on the main thread; a hard query freezes the tab for up to
  the solver timeout.
- CheerpJ returns Java `long` values through JS Numbers, so 64-bit values
  above 2^53 read back from Z3 lose precision. The verifier only reads
  int64s for list lengths; numeric counterexamples go through
  `Z3_get_numeral_string`.
- CheerpJ's community license covers this (personal, non-commercial) use and
  requires loading its runtime from its CDN; the runtime is not self-hosted.
