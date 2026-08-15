# Dafny in the browser — the .NET host

The `/tools/dafny` page runs the real Dafny verifier client-side. This
directory holds the C# host that makes that possible; its publish output is
committed at `public/dafny/_framework` (rebuilding needs the .NET SDK, which
the site's deploy environment doesn't have).

## How it works

- **DafnyPipeline 4.11.0** (NuGet) brings in DafnyCore and Boogie 3.5.5 —
  the same assemblies the `dafny` CLI runs. The multithreaded .NET wasm
  runtime executes them as-is; nothing about Dafny is forked.
- **Boogie's solver connection is injected, not patched.** Boogie normally
  spawns a `z3` process and speaks SMT-LIB2 over stdin/stdout. Its options
  expose `CreateSolver`, so `Z3Bridge.cs` supplies an `SMTLibSolver` that
  buffers commands and flushes them through a JS import into
  `Z3_eval_smtlib2_string` on the Z3 wasm build in `public/z3` (the one the
  LDLf-MT tool already ships). That API keeps solver state on its context
  between calls, which is exactly what makes Boogie's push/pop dialogue work
  over function calls instead of a pipe.
- **`Program.cs`** wires the wasm-specific corners: console streams that
  don't exist, `TheProverFactory` set directly because `Assembly.LoadFrom`
  has no filesystem, the prelude written into the in-memory FS, and one
  long-lived `ExecutionEngine` (each engine spawns dedicated threads; wasm
  can't keep paying that per call).
- The page-side loader is `src/lib/dafny/engine.ts`; the Z3 handle registry
  it passes in is `src/lib/dafny/z3smt.ts`.

## Rebuilding

```sh
./build.sh
```

## Known limitations

- Runs on the page's main thread: the MT .NET runtime asserts when booted
  inside a nested worker. Z3 solves on its own pthreads, so only the
  Dafny/Boogie phases can briefly jank the UI.
- `/timeLimit:15` is passed to Boogie, but Z3-wasm timer behaviour under
  Emscripten is best-effort; a pathological program can still spin a pthread.
- `{:extern}`/compilation targets are irrelevant here — the host only
  verifies (`/compile:0`).
