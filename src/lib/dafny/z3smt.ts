/**
 * Low-level Z3 for the Dafny verifier: SMT-LIB2 text in, solver output text
 * out, via Z3_eval_smtlib2_string, which keeps solver state on its context
 * between calls — that persistence is what makes Boogie's push/pop dialogue
 * work over a function call instead of a process pipe.
 *
 * Same loading strategy as the LDLf-MT tool's z3.ts: the ~34 MB wasm build in
 * /public/z3 arrives via a script tag, then the z3-solver package's low-level
 * API is wired up through deep imports. Needs a cross-origin-isolated page.
 */

export class SolverUnavailableError extends Error {
  constructor(cause?: string) {
    super(cause ?? "The Z3 solver could not be loaded.");
    this.name = "SolverUnavailableError";
  }
}

type Z3LowLevel = {
  mk_config(): unknown;
  del_config(cfg: unknown): void;
  mk_context(cfg: unknown): unknown;
  del_context(ctx: unknown): void;
  eval_smtlib2_string(ctx: unknown, smt: string): Promise<string>;
};

declare global {
  interface Window {
    initZ3?: unknown;
  }
}

const SCRIPT_URL = "/z3/z3-built.js";

function loadScript(): Promise<unknown> {
  if (window.initZ3 !== undefined) return Promise.resolve(window.initZ3);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.onload = () => {
      if (window.initZ3 !== undefined) resolve(window.initZ3);
      else reject(new SolverUnavailableError("z3-built.js loaded but initZ3 is missing."));
    };
    script.onerror = () => reject(new SolverUnavailableError("Failed to fetch z3-built.js."));
    document.head.appendChild(script);
  });
}

let z3Promise: Promise<Z3LowLevel> | null = null;

export function loadZ3LowLevel(): Promise<Z3LowLevel> {
  if (z3Promise) return z3Promise;

  z3Promise = (async () => {
    try {
      if (!crossOriginIsolated) {
        throw new SolverUnavailableError(
          "This page is not cross-origin isolated, so SharedArrayBuffer is unavailable.",
        );
      }
      const initZ3 = await loadScript();
      const low = await import("z3-solver/build/low-level");
      const lowLevel = await low.init(initZ3 as Parameters<typeof low.init>[0], {});
      return lowLevel.Z3 as unknown as Z3LowLevel;
    } catch (e) {
      z3Promise = null;
      if (e instanceof SolverUnavailableError) throw e;
      throw new SolverUnavailableError(e instanceof Error ? e.message : undefined);
    }
  })();

  return z3Promise;
}

/**
 * The context registry the .NET side talks to: integer handles so the C#
 * bridge never holds raw pointers.
 */
const contexts = new Map<number, unknown>();
let nextId = 1;
let z3: Z3LowLevel | null = null;

export async function initSmtBridge(): Promise<SmtBridge> {
  z3 = await loadZ3LowLevel();
  return bridge;
}

export function solverReady(): boolean {
  return z3 !== null;
}

export type SmtBridge = {
  createContext(): number;
  evalSmtlib(id: number, smt: string): Promise<string>;
  disposeContext(id: number): void;
};

/**
 * Safe to hand to the .NET runtime before Z3 is loaded: the runtime only
 * calls these when a solver is constructed, and verify() awaits
 * initSmtBridge() first.
 */
export const bridge: SmtBridge = {
  createContext() {
    const cfg = z3!.mk_config();
    const ctx = z3!.mk_context(cfg);
    z3!.del_config(cfg);
    contexts.set(nextId, ctx);
    return nextId++;
  },
  async evalSmtlib(id: number, smt: string) {
    return await z3!.eval_smtlib2_string(contexts.get(id), smt);
  },
  disposeContext(id: number) {
    const ctx = contexts.get(id);
    if (ctx !== undefined) {
      z3!.del_context(ctx);
      contexts.delete(id);
    }
  },
};
