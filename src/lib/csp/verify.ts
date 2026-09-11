/**
 * Runtime verification of a trace against a CSP# model. The model is
 * nondeterministic (internal choice, τ, hiding, interleaving), so the checker
 * follows a *set* of configurations, like simulating an NFA: τ-closure, step
 * on the observed event, τ-closure again. The trace is accepted iff the set
 * never empties. Only the states the trace actually reaches are explored, so
 * this is bounded by the trace, not by the model's state space.
 */

import { CspError, type Expr, type Loc, type Spec } from "./ast";
import {
  CspRuntimeError,
  evalExpr,
  fmtValue,
  initialStore,
  storeKey,
  type Ctx,
  type Store,
  type Value,
} from "./eval";
import { parseProcessRef, parseSpec } from "./parser";
import { keyOf, labelName, step, TICK_NAME, type Move, type RT } from "./semantics";

export type Config = { rt: RT; store: Store };

export type TraceItem = { name: string; count: number; loc?: { start: number; end: number } };

/**
 * PAT's "Simulate Trace" format: events separated by commas (or whitespace),
 * `e(5)` meaning `e` five times. Synchronous channel handshakes are `c.v`,
 * asynchronous sends and receives `c!v` and `c?v`, termination `terminate`.
 */
export function parseTrace(text: string): TraceItem[] {
  const items: TraceItem[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*(?:[.!?][A-Za-z0-9_\-.]*)?(?:\[\d+\][!?.][A-Za-z0-9_\-.]*)?|✓)\s*(?:\((\d+)\))?/g;
  let pos = 0;
  const src = text;
  while (pos < src.length) {
    const rest = src.slice(pos);
    const skip = rest.match(/^[\s,;]+/);
    if (skip) {
      pos += skip[0].length;
      continue;
    }
    re.lastIndex = 0;
    const m = re.exec(rest);
    if (!m || m.index !== 0) {
      throw new CspError(`cannot read trace at "${rest.slice(0, 12)}"`);
    }
    let name = m[1];
    if (name === "✓" || name === "tick") name = TICK_NAME;
    const count = m[2] ? parseInt(m[2], 10) : 1;
    items.push({ name, count, loc: { start: pos, end: pos + m[0].length } });
    pos += m[0].length;
  }
  return items;
}

// ---------------------------------------------------------------------------

export type StepReport = {
  index: number;
  event: string;
  ok: boolean;
  /** Distinct configurations after this event (0 when rejected). */
  configs: number;
  /** Visible events that were enabled before this step, sorted. */
  enabled: string[];
};

export type StateSummary = { vars: { name: string; value: string }[]; chans: { name: string; items: string }[] };

export type CheckResult = {
  steps: StepReport[];
  accepted: boolean;
  /** Visible events enabled after the accepted prefix. */
  enabled: string[];
  configs: number;
  /** No configuration has any move left (and none can terminate). */
  deadlocked: boolean;
  /** The last accepted event was termination. */
  terminated: boolean;
  states: StateSummary[];
  error?: { message: string; loc?: Loc };
};

export type CheckOptions = {
  /** Cap on distinct configurations tracked at once. */
  maxConfigs?: number;
};

const DEFAULT_MAX_CONFIGS = 4000;

function cfgKey(c: Config): string {
  return `${keyOf(c.rt)}|${storeKey(c.store)}`;
}

/** Top-level moves: unpaired channel offers are dropped and atomic priority applies. */
function topMoves(c: Config, ctx: Ctx): Move[] {
  const all = step(c.rt, c.store, ctx).filter((m) => m.label.kind !== "offer-out" && m.label.kind !== "offer-in");
  if (all.some((m) => m.atomic)) return all.filter((m) => m.atomic);
  return all;
}

type Closed = { configs: Map<string, Config>; moves: Map<string, Move[]> };

/** Close a set of configurations under τ, remembering each one's moves. */
function tauClosure(seed: Config[], ctx: Ctx, maxConfigs: number): Closed {
  const configs = new Map<string, Config>();
  const moves = new Map<string, Move[]>();
  const work: Config[] = [];
  for (const c of seed) {
    const k = cfgKey(c);
    if (!configs.has(k)) {
      configs.set(k, c);
      work.push(c);
    }
  }
  while (work.length) {
    const c = work.pop()!;
    const k = cfgKey(c);
    const ms = topMoves(c, ctx);
    moves.set(k, ms);
    for (const m of ms) {
      if (m.label.kind !== "tau") continue;
      const n: Config = { rt: m.next, store: m.store };
      const nk = cfgKey(n);
      if (!configs.has(nk)) {
        if (configs.size >= maxConfigs) {
          throw new CspRuntimeError(
            `more than ${maxConfigs} configurations reachable by invisible steps — the model may diverge (a τ loop)`,
          );
        }
        configs.set(nk, n);
        work.push(n);
      }
    }
  }
  return { configs, moves };
}

function enabledEvents(closed: Closed): string[] {
  const names = new Set<string>();
  for (const ms of closed.moves.values()) {
    for (const m of ms) if (m.label.kind === "ev" || m.label.kind === "tick") names.add(labelName(m.label));
  }
  return [...names].sort();
}

function summarize(closed: Closed, ctx: Ctx, limit = 6): StateSummary[] {
  const out: StateSummary[] = [];
  const seen = new Set<string>();
  for (const c of closed.configs.values()) {
    const k = storeKey(c.store);
    if (seen.has(k)) continue;
    seen.add(k);
    const hidden = new Set(ctx.spec.vars.filter((v) => v.hidden).map((v) => v.name));
    out.push({
      vars: Object.keys(c.store.vars)
        .filter((n) => !hidden.has(n))
        .map((name) => ({ name, value: fmtValue(c.store.vars[name]) })),
      chans: Object.keys(c.store.chans)
        .filter((n) => c.store.chans[n].size > 0 && !(n in c.store.chans && ctx.spec.channels.some((d) => d.count && d.name === n)))
        .map((name) => ({ name, items: c.store.chans[name].buf.map((t) => t.join(".")).join(", ") })),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Instantiate the process the user asked to run, e.g. `College()`. */
function initialConfig(spec: Spec, procText: string): { cfg: Config; ctx: Ctx } {
  const ref = parseProcessRef(procText);
  const { store, ctx } = initialStore(spec);
  const def = spec.procs.get(ref.name);
  if (!def) throw new CspError(`process '${ref.name}' is not defined`);
  if (def.params.length !== ref.args.length) {
    throw new CspError(`process '${ref.name}' expects ${def.params.length} argument(s), got ${ref.args.length}`);
  }
  const args: Value[] = ref.args.map((a: Expr) => evalExpr(a, {}, store, ctx));
  return { cfg: { rt: { t: "ref", name: ref.name, args, loc: def.loc }, store }, ctx };
}

export function checkTrace(source: string, procText: string, traceText: string, opts: CheckOptions = {}): CheckResult {
  const maxConfigs = opts.maxConfigs ?? DEFAULT_MAX_CONFIGS;
  const steps: StepReport[] = [];
  const fail = (message: string, loc?: Loc): CheckResult => ({
    steps,
    accepted: false,
    enabled: [],
    configs: 0,
    deadlocked: false,
    terminated: false,
    states: [],
    error: { message, loc },
  });

  let spec: Spec;
  let trace: TraceItem[];
  let start: { cfg: Config; ctx: Ctx };
  try {
    spec = parseSpec(source);
    trace = parseTrace(traceText);
    start = initialConfig(spec, procText);
  } catch (e) {
    if (e instanceof CspError) return fail(e.message, e.loc);
    throw e;
  }
  const { ctx } = start;

  try {
    let closed = tauClosure([start.cfg], ctx, maxConfigs);
    let index = 0;
    let terminated = false;

    for (const item of trace) {
      for (let r = 0; r < item.count; r++) {
        const enabled = enabledEvents(closed);
        const next: Config[] = [];
        for (const ms of closed.moves.values()) {
          for (const m of ms) {
            if ((m.label.kind === "ev" || m.label.kind === "tick") && labelName(m.label) === item.name) {
              next.push({ rt: m.next, store: m.store });
            }
          }
        }
        if (next.length === 0) {
          steps.push({ index, event: item.name, ok: false, configs: 0, enabled });
          return {
            steps,
            accepted: false,
            enabled,
            configs: closed.configs.size,
            deadlocked: enabled.length === 0,
            terminated,
            states: summarize(closed, ctx),
          };
        }
        closed = tauClosure(next, ctx, maxConfigs);
        terminated = item.name === TICK_NAME;
        steps.push({ index, event: item.name, ok: true, configs: closed.configs.size, enabled });
        index++;
      }
    }

    const enabled = enabledEvents(closed);
    return {
      steps,
      accepted: true,
      enabled,
      configs: closed.configs.size,
      deadlocked: enabled.length === 0 && !terminated,
      terminated,
      states: summarize(closed, ctx),
    };
  } catch (e) {
    if (e instanceof CspError) return fail(e.message, e.loc);
    throw e;
  }
}

/** Parse only, for editor diagnostics. Returns the first error, if any. */
export function checkSyntax(source: string): { error?: { message: string; loc?: Loc }; processes: string[]; suggested: string | null } {
  try {
    const spec = parseSpec(source);
    const processes = [...spec.procs.values()].map((p) => (p.params.length ? `${p.name}(${p.params.join(", ")})` : `${p.name}()`));
    let suggested: string | null = null;
    const a = spec.asserts[0];
    if (a) {
      suggested = a.proc.args.length ? null : `${a.proc.name}()`;
    }
    if (!suggested) {
      const noArgs = [...spec.procs.values()].filter((p) => p.params.length === 0);
      const last = noArgs[noArgs.length - 1];
      if (last) suggested = `${last.name}()`;
    }
    return { processes, suggested };
  } catch (e) {
    if (e instanceof CspError) return { error: { message: e.message, loc: e.loc }, processes: [], suggested: null };
    throw e;
  }
}
