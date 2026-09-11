/**
 * The CEL formal verifier in the browser.
 *
 * The real thing: cel-java 0.14.0's `verifier` package — the Z3-backed
 * framework Google released in August 2026 — compiled from its sources,
 * unmodified, and run on CheerpJ (a JVM in WebAssembly/JavaScript). Its one
 * native dependency, the JNI binding to libz3, is satisfied by
 * `z3bridge.ts`, which routes every `com.microsoft.z3.Native` call to a
 * single-threaded Z3 4.14.1 wasm build in /public/cel.
 *
 * Why a separate Z3 build rather than the one the other tools share: that one
 * is threaded and needs a cross-origin-isolated page, and CheerpJ's runtime
 * loads a helper iframe from its CDN that COEP would block. This build has no
 * threads, so the page needs no isolation headers at all.
 *
 * Everything runs on the main thread: Z3 solves synchronously inside the
 * native call, so a hard query janks the page for up to the timeout.
 */

import { buildZ3Natives, type Z3Module } from "./z3bridge";

export class EngineUnavailableError extends Error {
  constructor(cause?: string) {
    super(cause ?? "The verifier could not be loaded.");
    this.name = "EngineUnavailableError";
  }
}

export type LoadPhase = "z3" | "cheerpj" | "jar";

export type VerificationStatus = "VERIFIED" | "VIOLATED" | "INCONCLUSIVE";

export type VerificationResult = {
  status: VerificationStatus;
  reason: string;
  counterexample: string;
  message: string;
};

export type EngineFailure = {
  kind: "compile" | "runtime";
  error: string;
  rootError: string;
  stack: string;
};

export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: EngineFailure };

export type PolicyInvariants = { id: string; result: VerificationResult }[];

export type VerifyOptions = {
  /** `name:type`, one per line. */
  variables: string;
  /** Identifiers the solver should treat as unknown, one per line. */
  unknowns: string;
  timeoutMs: number;
  unrollLimit: number;
};

type JavaFacade = {
  ping(): Promise<string>;
  compile(expr: string, vars: string): Promise<string>;
  sat(expr: string, vars: string, timeoutMs: number, unroll: number, unknowns: string): Promise<string>;
  valid(expr: string, vars: string, timeoutMs: number, unroll: number, unknowns: string): Promise<string>;
  equiv(a: string, b: string, vars: string, timeoutMs: number, unroll: number, unknowns: string): Promise<string>;
  policyInvariants(yaml: string, vars: string, timeoutMs: number, unroll: number, unknowns: string): Promise<string>;
  policyEquiv(a: string, b: string, vars: string, timeoutMs: number, unroll: number, unknowns: string): Promise<string>;
};

declare global {
  interface Window {
    initZ3Cel?: (opts?: Record<string, unknown>) => Promise<Z3Module>;
    cheerpjInit?: (opts: Record<string, unknown>) => Promise<void>;
    cheerpjRunLibrary?: (classPath: string) => Promise<unknown>;
  }
}

const Z3_SCRIPT_URL = "/cel/z3-cel.js";
const Z3_ASSET_DIR = "/cel/";
export const CHEERPJ_VERSION = "4.3";
const CHEERPJ_LOADER_URL = `https://cjrtnc.leaningtech.com/${CHEERPJ_VERSION}/loader.js`;
/** CheerpJ mounts the page origin at /app. */
const JAR_CLASSPATH = "/app/cel/cel-verifier-web.jar";

function loadScript(src: string, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => (ready() ? resolve() : reject(new EngineUnavailableError(`${src} loaded but did not initialise.`)));
    script.onerror = () => reject(new EngineUnavailableError(`Failed to fetch ${src}.`));
    document.head.appendChild(script);
  });
}

let enginePromise: Promise<JavaFacade> | null = null;

/**
 * Boots Z3 wasm, then the JVM with the Z3 natives wired in, then the verifier
 * jar. Idempotent; the phase callback only fires on the first load.
 */
export function loadEngine(onPhase?: (phase: LoadPhase) => void): Promise<JavaFacade> {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    try {
      onPhase?.("z3");
      await loadScript(Z3_SCRIPT_URL, () => typeof window.initZ3Cel === "function");
      const z3 = await window.initZ3Cel!({
        locateFile: (file: string) => Z3_ASSET_DIR + file,
        print: () => {},
        printErr: (line: string) => console.warn("[z3]", line),
      });

      onPhase?.("cheerpj");
      await loadScript(CHEERPJ_LOADER_URL, () => typeof window.cheerpjInit === "function");
      await window.cheerpjInit!({
        version: 11,
        status: "none",
        natives: buildZ3Natives(z3),
        javaProperties: ["user.timezone=UTC"],
      });

      onPhase?.("jar");
      const lib = (await window.cheerpjRunLibrary!(JAR_CLASSPATH)) as {
        dev: { cel: { verifier: { tools: { CelVerifierWeb: Promise<JavaFacade> } } } };
      };
      const facade = await lib.dev.cel.verifier.tools.CelVerifierWeb;
      await facade.ping();
      return facade;
    } catch (e) {
      enginePromise = null;
      if (e instanceof EngineUnavailableError) throw e;
      throw new EngineUnavailableError(e instanceof Error ? e.message : String(e));
    }
  })();

  return enginePromise;
}

/** Z3 and the JVM are both single-threaded here, so calls are serialised. */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function parse<T>(json: string): Outcome<T> {
  const raw = JSON.parse(json) as { ok: boolean } & Record<string, unknown>;
  if (raw.ok) {
    const value: Record<string, unknown> = { ...raw };
    delete value.ok;
    return { ok: true, value: value as T };
  }
  return {
    ok: false,
    failure: {
      kind: raw.kind as EngineFailure["kind"],
      error: String(raw.error ?? ""),
      rootError: String(raw.rootError ?? ""),
      stack: String(raw.stack ?? ""),
    },
  };
}

export function checkSatisfiable(expr: string, o: VerifyOptions): Promise<Outcome<VerificationResult>> {
  return enqueue(async () => {
    const f = await loadEngine();
    return parse(await f.sat(expr, o.variables, o.timeoutMs, o.unrollLimit, o.unknowns));
  });
}

export function checkValid(expr: string, o: VerifyOptions): Promise<Outcome<VerificationResult>> {
  return enqueue(async () => {
    const f = await loadEngine();
    return parse(await f.valid(expr, o.variables, o.timeoutMs, o.unrollLimit, o.unknowns));
  });
}

export function checkEquivalence(a: string, b: string, o: VerifyOptions): Promise<Outcome<VerificationResult>> {
  return enqueue(async () => {
    const f = await loadEngine();
    return parse(await f.equiv(a, b, o.variables, o.timeoutMs, o.unrollLimit, o.unknowns));
  });
}

export function checkPolicyInvariants(yaml: string, o: VerifyOptions): Promise<Outcome<{ invariants: PolicyInvariants }>> {
  return enqueue(async () => {
    const f = await loadEngine();
    return parse(await f.policyInvariants(yaml, o.variables, o.timeoutMs, o.unrollLimit, o.unknowns));
  });
}

export function checkPolicyEquivalence(a: string, b: string, o: VerifyOptions): Promise<Outcome<VerificationResult>> {
  return enqueue(async () => {
    const f = await loadEngine();
    return parse(await f.policyEquiv(a, b, o.variables, o.timeoutMs, o.unrollLimit, o.unknowns));
  });
}

/** Parse and type-check only — no solver involved. */
export function compileOnly(expr: string, variables: string): Promise<Outcome<{ type: string; expr: string }>> {
  return enqueue(async () => {
    const f = await loadEngine();
    return parse(await f.compile(expr, variables));
  });
}
