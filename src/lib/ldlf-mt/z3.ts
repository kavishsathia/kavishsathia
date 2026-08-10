/**
 * Z3 in the browser, for mintermization.
 *
 * The wasm build lives in /public/z3 (copied from node_modules on install —
 * it's ~34 MB, so it loads lazily and only on this tool). The z3-solver
 * package's browser entry expects a global `initZ3` from a script tag; we
 * load that script, then wire its output into the package's high-level API
 * via deep imports, skipping the entry's global-sniffing.
 *
 * Requires a cross-origin-isolated page (SharedArrayBuffer) — see the
 * COOP/COEP headers in next.config.ts.
 */

import type { LinExpr, Predicate } from "./predicates";

export class SolverUnavailableError extends Error {
  constructor(cause?: string) {
    super(cause ?? "The Z3 solver could not be loaded.");
    this.name = "SolverUnavailableError";
  }
}

// Minimal structural types for the slice of the Z3 API we use — the
// generated typings are context-generic in a way that fights inference.
type Bool = { not(): Bool };
type Arith = {
  add(other: Arith | number): Arith;
  mul(other: Arith | number): Arith;
  lt(other: Arith | number): Bool;
  le(other: Arith | number): Bool;
  eq(other: Arith | number): Bool;
  neq(other: Arith | number): Bool;
};
type Model = { eval(expr: Arith, completion?: boolean): { toString(): string } };
type AstVector = { length(): number; get(i: number): { toString(): string } };
type Solver = {
  set(key: string, value: boolean): void;
  add(expr: Bool): void;
  addAndTrack(expr: Bool, tracker: Bool): void;
  check(): Promise<"sat" | "unsat" | "unknown">;
  model(): Model;
  unsatCore(): AstVector;
};
type Ctx = {
  Int: { const(name: string): Arith; val(value: number): Arith };
  Bool: { const(name: string): Bool };
  Solver: new () => Solver;
};
export type Z3Api = { Context(name: string): unknown };

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

let apiPromise: Promise<Z3Api> | null = null;

export function loadZ3(): Promise<Z3Api> {
  if (apiPromise) return apiPromise;

  apiPromise = (async () => {
    try {
      if (!crossOriginIsolated) {
        throw new SolverUnavailableError(
          "This page is not cross-origin isolated, so SharedArrayBuffer is unavailable.",
        );
      }
      const initZ3 = await loadScript();
      const [low, high] = await Promise.all([
        import("z3-solver/build/low-level"),
        import("z3-solver/build/high-level"),
      ]);
      const lowLevel = await low.init(
        initZ3 as Parameters<typeof low.init>[0],
        {},
      );
      return high.createApi(lowLevel.Z3, lowLevel.em) as Z3Api;
    } catch (e) {
      apiPromise = null;
      if (e instanceof SolverUnavailableError) throw e;
      throw new SolverUnavailableError(e instanceof Error ? e.message : undefined);
    }
  })();

  return apiPromise;
}

/** Fetches + instantiates Z3 without solving anything. */
export function preloadZ3(): void {
  void loadZ3().catch(() => {
    /* surfaced on the next mintermize() */
  });
}

// ---------------------------------------------------------------------------
// Mintermization
// ---------------------------------------------------------------------------

export type Minterm = {
  /** Bit i set means predicates[i] holds in this letter. */
  mask: number;
  status: "sat" | "unsat" | "unknown";
  /** A concrete assignment realising this letter (sat only). */
  witness?: Record<string, number>;
  /** Indices of the predicates whose combination is contradictory (unsat only). */
  conflict?: number[];
};

let contextCounter = 0;

function toArith(ctx: Ctx, expr: LinExpr): Arith {
  let acc = ctx.Int.val(expr.constant);
  for (const [v, c] of expr.coeffs) {
    acc = acc.add(ctx.Int.const(v).mul(c));
  }
  return acc;
}

function toBool(ctx: Ctx, pred: Predicate): Bool {
  const lhs = toArith(ctx, pred.expr);
  switch (pred.op) {
    case "<":
      return lhs.lt(0);
    case "<=":
      return lhs.le(0);
    case "=":
      return lhs.eq(0);
    case "!=":
      return lhs.neq(0);
  }
}

/**
 * Checks every combination of the predicates: each satisfiable combination is
 * a letter of the alphabet (with a witness assignment), each unsatisfiable
 * one is pruned (with the subset of predicates that clash).
 */
export async function mintermize(
  predicates: Predicate[],
  options: { api?: Z3Api; onProgress?: (done: number, total: number) => void } = {},
): Promise<Minterm[]> {
  const api = options.api ?? (await loadZ3());
  const ctx = api.Context(`minterms-${contextCounter++}`) as Ctx;

  const exprs = predicates.map((p) => toBool(ctx, p));
  const variables = Array.from(new Set(predicates.flatMap((p) => p.variables))).sort();
  const varConsts = new Map(variables.map((v) => [v, ctx.Int.const(v)]));

  const total = 1 << predicates.length;
  const out: Minterm[] = [];

  for (let mask = 0; mask < total; mask++) {
    const solver = new ctx.Solver();
    solver.set("unsat_core", true);
    const trackers = predicates.map((_, i) => ctx.Bool.const(`track_${i}`));
    predicates.forEach((_, i) => {
      solver.addAndTrack(mask & (1 << i) ? exprs[i] : exprs[i].not(), trackers[i]);
    });

    const result = await solver.check();
    if (result === "sat") {
      const model = solver.model();
      const witness: Record<string, number> = {};
      for (const [v, c] of varConsts) {
        witness[v] = Number(model.eval(c, true).toString());
      }
      out.push({ mask, status: "sat", witness });
    } else if (result === "unsat") {
      const core = solver.unsatCore();
      const conflict: number[] = [];
      for (let i = 0; i < core.length(); i++) {
        const m = /^track_(\d+)$/.exec(core.get(i).toString());
        if (m) conflict.push(parseInt(m[1], 10));
      }
      conflict.sort((a, b) => a - b);
      out.push({ mask, status: "unsat", conflict });
    } else {
      // Shouldn't happen for linear integer arithmetic; keep the letter to
      // stay sound (never prune something that might be possible).
      out.push({ mask, status: "unknown" });
    }
    options.onProgress?.(mask + 1, total);
  }

  return out;
}
