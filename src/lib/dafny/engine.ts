/**
 * The Dafny verifier in the browser.
 *
 * The real thing, not a port: Dafny 4.11 and Boogie 3.5.5 — the same C#
 * assemblies the CLI runs — execute on the .NET wasm runtime in /public/dafny,
 * and Boogie's solver connection is rerouted from a z3 subprocess to the Z3
 * wasm build already used by the LDLf-MT tool. A small C# host (see
 * wasm-src/dafny) exposes Check/Verify over JS interop.
 *
 * Loading is two-stage on purpose: Check (parse + resolve, what live
 * diagnostics need) only requires the ~10 MB .NET runtime; the ~34 MB Z3
 * download is deferred until the first actual verify.
 *
 * Runs on the page's main thread: the multithreaded .NET runtime refuses to
 * boot inside a nested worker, and Z3 does its solving on its own pthreads,
 * so only the Dafny/Boogie phases can briefly jank the UI.
 */

import { bridge, initSmtBridge, solverReady, SolverUnavailableError } from "./z3smt";

export { initSmtBridge, SolverUnavailableError };

export class EngineUnavailableError extends Error {
  constructor(cause?: string) {
    super(cause ?? "The Dafny engine could not be loaded.");
    this.name = "EngineUnavailableError";
  }
}

export type LoadPhase = "dotnet" | "z3";

export type DafnyDiagnostic = {
  /** 1 = error, 2 = warning, 3+ = info. */
  severity: number;
  message: string;
  source: string;
  /** 1-based line, 1-based columns (Dafny reports 0-based characters). */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  related: { message: string; line: number; column: number }[];
};

export type CheckOutcome = {
  ok: boolean;
  error: string | null;
  diagnostics: DafnyDiagnostic[];
};

export type VerifyOutcome = {
  ok: boolean;
  /** Human-readable failure that precedes verification (parse/resolve). */
  error: string | null;
  verified: number;
  errors: number;
  inconclusive: number;
  timeouts: number;
  diagnostics: DafnyDiagnostic[];
};

type DafnyApi = {
  Check(source: string): Promise<string>;
  Verify(source: string): Promise<string>;
};

type RawResult = {
  Ok: boolean;
  Error?: string | null;
  Crash?: string | null;
  Diagnostics?: string | null;
  Outcome?: string | null;
  VerifiedCount?: number;
  ErrorCount?: number;
  InconclusiveCount?: number;
  TimeoutCount?: number;
};

const DOTNET_URL = "/dafny/_framework/dotnet.js";

let runtimePromise: Promise<DafnyApi> | null = null;

/** Boots the .NET runtime with Dafny + Boogie. Idempotent. */
export function loadRuntime(): Promise<DafnyApi> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    try {
      // Held in a variable so the bundler leaves this alone and the browser
      // resolves it against /public at runtime.
      const url = DOTNET_URL;
      const mod = (await import(/* webpackIgnore: true */ url)) as {
        dotnet: {
          create(): Promise<{
            getAssemblyExports(name: string): Promise<unknown>;
            getConfig(): { mainAssemblyName: string };
            setModuleImports(name: string, imports: unknown): void;
            runMain(): Promise<unknown>;
          }>;
        };
      };
      const runtime = await mod.dotnet.create();
      runtime.setModuleImports("main.js", { z3: bridge });
      const exports = (await runtime.getAssemblyExports(
        runtime.getConfig().mainAssemblyName,
      )) as { DafnyWasm: { DafnyHost: DafnyApi } };
      await runtime.runMain();
      return exports.DafnyWasm.DafnyHost;
    } catch (e) {
      runtimePromise = null;
      throw new EngineUnavailableError(e instanceof Error ? e.message : undefined);
    }
  })();

  return runtimePromise;
}

/**
 * The C# host keeps one engine and one output sink, so calls must not
 * interleave — everything goes through this one-at-a-time queue.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

type RawDiagnostic = {
  location?: {
    range?: {
      start?: { line?: number; character?: number };
      end?: { line?: number; character?: number };
    };
  };
  severity?: number;
  message?: string;
  source?: string;
  relatedInformation?: {
    location?: { range?: { start?: { line?: number; character?: number } } };
    message?: string;
  }[];
};

function parseDiagnostics(text: string | null | undefined): DafnyDiagnostic[] {
  if (!text) return [];
  const out: DafnyDiagnostic[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const d = JSON.parse(trimmed) as RawDiagnostic;
      if (typeof d.message !== "string") continue;
      out.push({
        severity: d.severity ?? 1,
        message: d.message,
        source: d.source ?? "",
        line: d.location?.range?.start?.line ?? 0,
        column: (d.location?.range?.start?.character ?? 0) + 1,
        endLine: d.location?.range?.end?.line ?? 0,
        endColumn: (d.location?.range?.end?.character ?? 0) + 1,
        related: (d.relatedInformation ?? []).map((r) => ({
          message: r.message ?? "",
          line: r.location?.range?.start?.line ?? 0,
          column: (r.location?.range?.start?.character ?? 0) + 1,
        })),
      });
    } catch {
      // Non-JSON output line; ignore.
    }
  }
  return out;
}

/** Parse + resolve only — fast enough to run as the user types. */
export async function check(source: string): Promise<CheckOutcome> {
  const api = await loadRuntime();
  const raw = JSON.parse(
    await enqueue(() => api.Check(source)),
  ) as RawResult;
  if (raw.Crash) {
    throw new EngineUnavailableError(raw.Crash.split("\n")[0]);
  }
  return {
    ok: raw.Ok,
    error: raw.Error ?? null,
    diagnostics: parseDiagnostics(raw.Diagnostics),
  };
}

/** The full pipeline: parse, resolve, translate to Boogie, discharge in Z3. */
export async function verify(
  source: string,
  onPhase?: (phase: LoadPhase) => void,
): Promise<VerifyOutcome> {
  if (!runtimePromise) onPhase?.("dotnet");
  const api = await loadRuntime();
  if (!solverReady()) onPhase?.("z3");
  await initSmtBridge();
  const raw = JSON.parse(
    await enqueue(() => api.Verify(source)),
  ) as RawResult;
  if (raw.Crash) {
    throw new EngineUnavailableError(raw.Crash.split("\n")[0]);
  }
  return {
    ok: raw.Ok,
    error: raw.Error ?? null,
    verified: raw.VerifiedCount ?? 0,
    errors: raw.ErrorCount ?? 0,
    inconclusive: raw.InconclusiveCount ?? 0,
    timeouts: raw.TimeoutCount ?? 0,
    diagnostics: parseDiagnostics(raw.Diagnostics),
  };
}
