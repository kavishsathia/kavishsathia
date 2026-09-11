/**
 * Operational semantics of CSP#: the firing rules from Sun, Liu & Dong,
 * "PAT: Language Syntax and Semantics", adjusted where the PAT 3.5 manual
 * documents different behaviour (general vs external choice, atomic,
 * ifa/ifb, synchronous channels, data operations outside alphabets).
 *
 * A configuration is a runtime term plus a store. `step` returns every move
 * a configuration can make: visible events, τ, ✓, and — for synchronous
 * channels — half-handshakes ("offers") that only become a move once paired
 * with a matching offer inside an interleaving or parallel composition.
 */

import {
  CspError,
  type EventListItem,
  type EventName,
  type Expr,
  type Loc,
  type Proc,
  type ChoiceOp,
} from "./ast";
import {
  CspRuntimeError,
  envKey,
  evalBool,
  evalExpr,
  evalInt,
  expandRanges,
  fmtValue,
  isArray,
  runBlock,
  type Ctx,
  type Env,
  type Scalar,
  type Store,
  type Value,
} from "./eval";

// ---------------------------------------------------------------------------
// Runtime terms
// ---------------------------------------------------------------------------

type PrefixNode = Extract<Proc, { k: "prefix" }>;
type IfNode = Extract<Proc, { k: "if" }>;
type CaseNode = Extract<Proc, { k: "case" }>;

export type RT =
  | { t: "stop" }
  | { t: "skip" }
  | { t: "prefix"; node: PrefixNode; env: Env }
  | { t: "ref"; name: string; args: Value[]; loc: Loc }
  | { t: "guard"; cond: Expr; body: Proc; env: Env }
  | { t: "seq"; p: RT; q: Proc; env: Env }
  | { t: "choice"; op: ChoiceOp; ps: RT[] }
  /** Alphabets are fixed when the composition is first evaluated, as in PAT. */
  | { t: "par"; ps: RT[]; alpha: Set<string>[] | null }
  | { t: "inter"; ps: RT[] }
  | { t: "interrupt"; p: RT; q: RT }
  | { t: "hide"; p: RT; events: Set<string> }
  | { t: "if"; node: IfNode; env: Env }
  | { t: "case"; node: CaseNode; env: Env }
  | { t: "atomic"; p: RT }
  | { t: "assert"; cond: Expr; env: Env; loc: Loc };

export const STOP: RT = { t: "stop" };
export const SKIP: RT = { t: "skip" };

const keyCache = new WeakMap<object, string>();

/** A canonical serialisation, used to deduplicate configurations. */
export function keyOf(rt: RT): string {
  if (rt === STOP) return "0";
  if (rt === SKIP) return "1";
  const cached = keyCache.get(rt);
  if (cached) return cached;
  let k: string;
  switch (rt.t) {
    case "stop": k = "0"; break;
    case "skip": k = "1"; break;
    case "prefix": k = `p${rt.node.id}{${envKey(rt.env)}}`; break;
    case "ref": k = `r${rt.name}(${rt.args.map(fmtValue).join(",")})`; break;
    case "guard": k = `g${rt.body.id}{${envKey(rt.env)}}`; break;
    case "seq": k = `s(${keyOf(rt.p)};${rt.q.id}{${envKey(rt.env)}})`; break;
    case "choice": k = `c${rt.op}(${rt.ps.map(keyOf).join(",")})`; break;
    case "par": k = `P(${rt.ps.map(keyOf).join(",")})`; break;
    case "inter": k = `I(${rt.ps.map(keyOf).join(",")})`; break;
    case "interrupt": k = `^(${keyOf(rt.p)},${keyOf(rt.q)})`; break;
    case "hide": k = `h(${keyOf(rt.p)}\\${[...rt.events].sort().join(",")})`; break;
    case "if": k = `i${rt.node.id}{${envKey(rt.env)}}`; break;
    case "case": k = `k${rt.node.id}{${envKey(rt.env)}}`; break;
    case "atomic": k = `a(${keyOf(rt.p)})`; break;
    case "assert": k = `A${rt.loc.pos}{${envKey(rt.env)}}`; break;
  }
  keyCache.set(rt, k);
  return k;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

export type Label =
  | { kind: "tau" }
  | { kind: "tick" }
  | { kind: "ev"; name: string }
  | { kind: "offer-out"; chan: string; vals: Scalar[] }
  | { kind: "offer-in"; chan: string };

export type Move = {
  label: Label;
  next: RT;
  store: Store;
  /** Fired from inside an `atomic{}` block: takes priority at the top level. */
  atomic: boolean;
  /** Carries a program block, so it never synchronises in `||`. */
  dataOp: boolean;
  /** For offer-in: try to receive these values, yielding the continuation. */
  recv?: (vals: Scalar[], store: Store) => { next: RT; store: Store } | null;
};

export const TICK_NAME = "terminate";

export function labelName(l: Label): string {
  switch (l.kind) {
    case "tau": return "tau";
    case "tick": return TICK_NAME;
    case "ev": return l.name;
    case "offer-out": return `${l.chan}!${l.vals.join(".")}`;
    case "offer-in": return `${l.chan}?`;
  }
}

function wrap(m: Move, f: (rt: RT) => RT): Move {
  const recv = m.recv;
  return {
    ...m,
    next: f(m.next),
    recv: recv
      ? (vals, store) => {
          const r = recv(vals, store);
          return r ? { next: f(r.next), store: r.store } : null;
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Instantiation: syntax + environment → runtime term
// ---------------------------------------------------------------------------

function evalRangeBindings(ranges: Range[], env: Env, store: Store, ctx: Ctx, loc: Loc): Env[] {
  return expandRanges(ranges, (e) => evalInt(e, env, store, ctx), loc).map((b) => ({ ...env, ...b }));
}
type Range = EventListItem["ranges"][number];

export function eventNameString(ev: EventName, env: Env, store: Store, ctx: Ctx): string {
  if (ev.args.length === 0) return ev.name;
  const parts = ev.args.map((a) => {
    const v = evalExpr(a, env, store, ctx);
    if (isArray(v)) throw new CspRuntimeError("an event argument cannot be an array", a.loc);
    return String(v);
  });
  return `${ev.name}.${parts.join(".")}`;
}

function eventListNames(items: EventListItem[], env: Env, store: Store, ctx: Ctx, loc: Loc): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    const envs = it.ranges.length ? evalRangeBindings(it.ranges, env, store, ctx, loc) : [env];
    for (const e of envs) out.add(eventNameString(it.ev, e, store, ctx));
  }
  return out;
}

export function inst(p: Proc, env: Env, store: Store, ctx: Ctx): RT {
  switch (p.k) {
    case "stop":
      return STOP;
    case "skip":
      return SKIP;
    case "prefix":
      return { t: "prefix", node: p, env };
    case "ref":
      return { t: "ref", name: p.name, args: p.args.map((a) => evalExpr(a, env, store, ctx)), loc: p.loc };
    case "guard":
      return { t: "guard", cond: p.cond, body: p.body, env };
    case "seq": {
      // P; Q; R  ≡  P; (Q; R) — only the head is instantiated now.
      const rest = p.ps.length === 2 ? p.ps[1] : { ...p, ps: p.ps.slice(1), id: p.id };
      return { t: "seq", p: inst(p.ps[0], env, store, ctx), q: rest, env };
    }
    case "choice":
      return { t: "choice", op: p.op, ps: p.ps.map((x) => inst(x, env, store, ctx)) };
    case "par": {
      const ps = p.ps.map((x) => inst(x, env, store, ctx));
      return p.op === "||" ? { t: "par", ps, alpha: null } : { t: "inter", ps };
    }
    case "indexed": {
      const envs = evalRangeBindings(p.ranges, env, store, ctx, p.loc);
      const ps = envs.map((e) => inst(p.body, e, store, ctx));
      return composeN(p.op, ps);
    }
    case "replicate": {
      if (p.count === "inf") throw new CspRuntimeError("unbounded replication ({..}) is not supported", p.loc);
      const n = evalInt(p.count, env, store, ctx);
      if (n < 0) throw new CspRuntimeError("replication count must be non-negative", p.loc);
      const ps: RT[] = [];
      for (let i = 0; i < n; i++) ps.push(inst(p.body, env, store, ctx));
      return composeN(p.op, ps);
    }
    case "interrupt":
      return { t: "interrupt", p: inst(p.p, env, store, ctx), q: inst(p.q, env, store, ctx) };
    case "hide":
      return { t: "hide", p: inst(p.p, env, store, ctx), events: eventListNames(p.events, env, store, ctx, p.loc) };
    case "if":
      return { t: "if", node: p, env };
    case "case":
      return { t: "case", node: p, env };
    case "atomic":
      return { t: "atomic", p: inst(p.p, env, store, ctx) };
    case "assert":
      return { t: "assert", cond: p.cond, env, loc: p.loc };
  }
}

function composeN(op: ChoiceOp | "||" | "|||", ps: RT[]): RT {
  if (ps.length === 0) return SKIP; // PAT: ||| {0} @ P() is Skip
  if (ps.length === 1) return ps[0];
  switch (op) {
    case "|||": return { t: "inter", ps };
    case "||": return { t: "par", ps, alpha: null };
    default: return { t: "choice", op, ps };
  }
}

// ---------------------------------------------------------------------------
// Alphabets (for alphabetised parallel composition)
// ---------------------------------------------------------------------------

/**
 * PAT's default alphabet: every plain event constituting the process
 * expression, unfolding each process reference once. Data operations
 * (events with programs) and channel events are excluded. Meeting the same
 * process again with different parameters is an error, exactly as in PAT,
 * which is when `#alphabet` must be declared.
 */
export function alphabetOf(rt: RT, store: Store, ctx: Ctx): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, string>();
  collectRT(rt, out, seen, store, ctx);
  return out;
}

function collectRT(rt: RT, out: Set<string>, seen: Map<string, string>, store: Store, ctx: Ctx) {
  switch (rt.t) {
    case "stop":
    case "skip":
    case "assert":
      return;
    case "prefix":
      collectProc(rt.node, rt.env, out, seen, store, ctx);
      return;
    case "ref":
      collectRef(rt.name, rt.args, out, seen, store, ctx, rt.loc);
      return;
    case "guard":
      collectProc(rt.body, rt.env, out, seen, store, ctx);
      return;
    case "seq":
      collectRT(rt.p, out, seen, store, ctx);
      collectProc(rt.q, rt.env, out, seen, store, ctx);
      return;
    case "choice":
    case "par":
    case "inter":
      for (const p of rt.ps) collectRT(p, out, seen, store, ctx);
      return;
    case "interrupt":
      collectRT(rt.p, out, seen, store, ctx);
      collectRT(rt.q, out, seen, store, ctx);
      return;
    case "hide": {
      const inner = new Set<string>();
      collectRT(rt.p, inner, seen, store, ctx);
      for (const e of inner) if (!rt.events.has(e)) out.add(e);
      return;
    }
    case "if":
      collectProc(rt.node.then, rt.env, out, seen, store, ctx);
      if (rt.node.else) collectProc(rt.node.else, rt.env, out, seen, store, ctx);
      return;
    case "case":
      for (const c of rt.node.cases) collectProc(c.body, rt.env, out, seen, store, ctx);
      if (rt.node.def) collectProc(rt.node.def, rt.env, out, seen, store, ctx);
      return;
    case "atomic":
      collectRT(rt.p, out, seen, store, ctx);
      return;
  }
}

function collectRef(
  name: string,
  args: Value[],
  out: Set<string>,
  seen: Map<string, string>,
  store: Store,
  ctx: Ctx,
  loc: Loc,
) {
  const def = ctx.spec.procs.get(name);
  if (!def) throw new CspRuntimeError(`undefined process '${name}'`, loc);
  if (def.params.length !== args.length) {
    throw new CspRuntimeError(`process '${name}' expects ${def.params.length} argument(s), got ${args.length}`, loc);
  }
  const env: Env = {};
  def.params.forEach((p, i) => (env[p] = args[i]));

  const declared = ctx.spec.alphabets.get(name);
  if (declared) {
    for (const e of eventListNames(declared, env, store, ctx, loc)) out.add(e);
    return;
  }

  const argKey = args.map(fmtValue).join(",");
  const prev = seen.get(name);
  if (prev !== undefined) {
    if (prev === argKey) return;
    throw new CspRuntimeError(
      `cannot compute the alphabet of '${name}': it is reached again with different parameters (${prev}) and (${argKey}). Declare it with #alphabet ${name} {…};`,
      loc,
    );
  }
  seen.set(name, argKey);
  collectProc(def.body, env, out, seen, store, ctx);
}

function collectProc(p: Proc, env: Env, out: Set<string>, seen: Map<string, string>, store: Store, ctx: Ctx) {
  switch (p.k) {
    case "stop":
    case "skip":
    case "assert":
      return;
    case "prefix": {
      const ev = p.ev;
      if (ev.k === "event" && !p.block) {
        try {
          out.add(eventNameString(ev.ev, env, store, ctx));
        } catch {
          // Depends on a variable not known statically (e.g. a channel input);
          // PAT raises here, we simply leave it out of the alphabet.
        }
      }
      collectProc(p.next, env, out, seen, store, ctx);
      return;
    }
    case "ref": {
      let args: Value[];
      try {
        args = p.args.map((a) => evalExpr(a, env, store, ctx));
      } catch {
        return;
      }
      collectRef(p.name, args, out, seen, store, ctx, p.loc);
      return;
    }
    case "guard":
      collectProc(p.body, env, out, seen, store, ctx);
      return;
    case "seq":
    case "choice":
    case "par":
      for (const q of p.ps) collectProc(q, env, out, seen, store, ctx);
      return;
    case "indexed": {
      let envs: Env[];
      try {
        envs = evalRangeBindings(p.ranges, env, store, ctx, p.loc);
      } catch {
        return;
      }
      for (const e of envs) collectProc(p.body, e, out, seen, store, ctx);
      return;
    }
    case "replicate":
      collectProc(p.body, env, out, seen, store, ctx);
      return;
    case "interrupt":
      collectProc(p.p, env, out, seen, store, ctx);
      collectProc(p.q, env, out, seen, store, ctx);
      return;
    case "hide": {
      const inner = new Set<string>();
      collectProc(p.p, env, inner, seen, store, ctx);
      let hidden = new Set<string>();
      try {
        hidden = eventListNames(p.events, env, store, ctx, p.loc);
      } catch {
        /* keep everything */
      }
      for (const e of inner) if (!hidden.has(e)) out.add(e);
      return;
    }
    case "if":
      collectProc(p.then, env, out, seen, store, ctx);
      if (p.else) collectProc(p.else, env, out, seen, store, ctx);
      return;
    case "case":
      for (const c of p.cases) collectProc(c.body, env, out, seen, store, ctx);
      if (p.def) collectProc(p.def, env, out, seen, store, ctx);
      return;
    case "atomic":
      collectProc(p.p, env, out, seen, store, ctx);
      return;
  }
}

// ---------------------------------------------------------------------------
// The step function
// ---------------------------------------------------------------------------

const MAX_UNFOLD_DEPTH = 400;
let unfoldDepth = 0;

/** All moves of a configuration. Offers are included; callers pair or drop them. */
export function step(rt: RT, store: Store, ctx: Ctx): Move[] {
  unfoldDepth = 0;
  return stepInner(rt, store, ctx);
}

function stepInner(rt: RT, store: Store, ctx: Ctx): Move[] {
  switch (rt.t) {
    case "stop":
      return [];
    case "skip":
      return [{ label: { kind: "tick" }, next: STOP, store, atomic: false, dataOp: false }];

    case "prefix":
      return stepPrefix(rt.node, rt.env, store, ctx);

    case "ref": {
      const def = ctx.spec.procs.get(rt.name);
      if (!def) throw new CspRuntimeError(`undefined process '${rt.name}'`, rt.loc);
      if (def.params.length !== rt.args.length) {
        throw new CspRuntimeError(
          `process '${rt.name}' expects ${def.params.length} argument(s), got ${rt.args.length}`,
          rt.loc,
        );
      }
      if (++unfoldDepth > MAX_UNFOLD_DEPTH) {
        throw new CspRuntimeError(`unguarded recursion: '${rt.name}' unfolds forever without an event`, rt.loc);
      }
      const env: Env = {};
      def.params.forEach((p, i) => (env[p] = rt.args[i]));
      return stepInner(inst(def.body, env, store, ctx), store, ctx);
    }

    case "guard":
      // [b]P: condition and first event are checked together (cond3).
      if (!evalBool(rt.cond, rt.env, store, ctx)) return [];
      return stepInner(inst(rt.body, rt.env, store, ctx), store, ctx);

    case "seq": {
      const out: Move[] = [];
      for (const m of stepInner(rt.p, store, ctx)) {
        if (m.label.kind === "tick") {
          // seq2: P's termination becomes a τ into Q.
          out.push({ label: { kind: "tau" }, next: inst(rt.q, rt.env, m.store, ctx), store: m.store, atomic: m.atomic, dataOp: false });
        } else {
          out.push(wrap(m, (n) => ({ t: "seq", p: n, q: rt.q, env: rt.env })));
        }
      }
      return out;
    }

    case "choice":
      return stepChoice(rt, store, ctx);

    case "inter":
      return compose(rt.ps, rt.ps.map((p) => stepInner(p, store, ctx)), null, (ps) => ({ t: "inter", ps }), store);

    case "par": {
      if (!rt.alpha) rt.alpha = rt.ps.map((p) => alphabetOf(p, store, ctx));
      const alpha = rt.alpha;
      return compose(rt.ps, rt.ps.map((p) => stepInner(p, store, ctx)), alpha, (ps) => ({ t: "par", ps, alpha }), store);
    }

    case "interrupt": {
      const out: Move[] = [];
      for (const m of stepInner(rt.p, store, ctx)) {
        out.push(wrap(m, (n) => ({ t: "interrupt", p: n, q: rt.q })));
      }
      for (const m of stepInner(rt.q, store, ctx)) {
        if (m.label.kind === "tau") out.push(wrap(m, (n) => ({ t: "interrupt", p: rt.p, q: n })));
        else out.push(m); // the interrupt fires: control passes to Q
      }
      return out;
    }

    case "hide": {
      const out: Move[] = [];
      for (const m of stepInner(rt.p, store, ctx)) {
        if (m.label.kind === "ev" && rt.events.has(m.label.name)) {
          out.push({ ...m, label: { kind: "tau" }, recv: undefined, next: { t: "hide", p: m.next, events: rt.events } });
        } else {
          out.push(wrap(m, (n) => ({ t: "hide", p: n, events: rt.events })));
        }
      }
      return out;
    }

    case "if": {
      const { node, env } = rt;
      const cond = evalBool(node.cond, env, store, ctx);
      if (node.variant === "ifb") {
        // Blocking: the check is a step of its own, but only once it holds.
        if (!cond) return [];
        return [{ label: { kind: "tau" }, next: inst(node.then, env, store, ctx), store, atomic: false, dataOp: false }];
      }
      const branch = cond ? inst(node.then, env, store, ctx) : node.else ? inst(node.else, env, store, ctx) : SKIP;
      if (node.variant === "ifa") return stepInner(branch, store, ctx); // check + first event together
      return [{ label: { kind: "tau" }, next: branch, store, atomic: false, dataOp: false }];
    }

    case "case": {
      const { node, env } = rt;
      let branch: RT = SKIP;
      let found = false;
      for (const c of node.cases) {
        if (evalBool(c.cond, env, store, ctx)) {
          branch = inst(c.body, env, store, ctx);
          found = true;
          break;
        }
      }
      if (!found && node.def) branch = inst(node.def, env, store, ctx);
      return [{ label: { kind: "tau" }, next: branch, store, atomic: false, dataOp: false }];
    }

    case "atomic":
      return stepInner(rt.p, store, ctx).map((m) => ({ ...wrap(m, (n) => ({ t: "atomic", p: n })), atomic: true }));

    case "assert": {
      if (!evalBool(rt.cond, rt.env, store, ctx)) {
        throw new CspRuntimeError("assertion failed", rt.loc);
      }
      return stepInner(SKIP, store, ctx);
    }
  }
}

function stepChoice(rt: Extract<RT, { t: "choice" }>, store: Store, ctx: Ctx): Move[] {
  if (rt.op === "<>") {
    // int1/int2: an internal τ picks a branch.
    return rt.ps.map((p) => ({ label: { kind: "tau" as const }, next: p, store, atomic: false, dataOp: false }));
  }
  const out: Move[] = [];
  rt.ps.forEach((p, i) => {
    for (const m of stepInner(p, store, ctx)) {
      if (rt.op === "[*]" && m.label.kind === "tau") {
        // ext2/ext4: a τ inside a branch does not resolve external choice.
        const ps = rt.ps.slice();
        ps[i] = m.next;
        out.push({ ...m, next: { t: "choice", op: "[*]", ps } });
      } else {
        // General choice `[]` is resolved by any move, τ included.
        out.push(m);
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Event prefixing and channels
// ---------------------------------------------------------------------------

function chanKey(chan: string, index: Expr | undefined, env: Env, store: Store, ctx: Ctx): string {
  return index === undefined ? chan : `${chan}[${evalInt(index, env, store, ctx)}]`;
}

function stepPrefix(node: PrefixNode, env: Env, store: Store, ctx: Ctx): Move[] {
  const ev = node.ev;
  const after = (s: Store, e: Env = env) => (node.block ? runBlock(node.block, e, s, ctx) : s);

  switch (ev.k) {
    case "tau": {
      const s = after(store);
      return [{ label: { kind: "tau" }, next: inst(node.next, env, s, ctx), store: s, atomic: false, dataOp: false }];
    }
    case "event": {
      const name = eventNameString(ev.ev, env, store, ctx);
      const s = after(store);
      return [{ label: { kind: "ev", name }, next: inst(node.next, env, s, ctx), store: s, atomic: false, dataOp: !!node.block }];
    }
    case "out": {
      const key = chanKey(ev.chan, ev.index, env, store, ctx);
      const ch = store.chans[key];
      if (!ch) throw new CspRuntimeError(`'${key}' is not a declared channel`, ev.loc);
      const vals = ev.exprs.map((e) => {
        const v = evalExpr(e, env, store, ctx);
        if (isArray(v)) throw new CspRuntimeError("cannot send an array on a channel", e.loc);
        return v;
      });
      if (ch.size === 0) {
        const s = after(store);
        return [{ label: { kind: "offer-out", chan: key, vals }, next: inst(node.next, env, s, ctx), store: s, atomic: false, dataOp: true }];
      }
      if (ch.buf.length >= ch.size) return []; // buffer full: wait
      const pushed: Store = { vars: store.vars, chans: { ...store.chans, [key]: { size: ch.size, buf: [...ch.buf, vals] } } };
      const s = after(pushed);
      return [{ label: { kind: "ev", name: `${key}!${vals.join(".")}` }, next: inst(node.next, env, s, ctx), store: s, atomic: false, dataOp: true }];
    }
    case "in": {
      const key = chanKey(ev.chan, ev.index, env, store, ctx);
      const ch = store.chans[key];
      if (!ch) throw new CspRuntimeError(`'${key}' is not a declared channel`, ev.loc);
      const receive = (vals: Scalar[], s0: Store): { next: RT; store: Store } | null => {
        const bound = matchInput(ev.pats, ev.guard, vals, env, s0, ctx);
        if (!bound) return null;
        const s = after(s0, bound);
        return { next: inst(node.next, bound, s, ctx), store: s };
      };
      if (ch.size === 0) {
        return [{ label: { kind: "offer-in", chan: key }, next: STOP, store, atomic: false, dataOp: true, recv: receive }];
      }
      if (ch.buf.length === 0) return []; // buffer empty: wait
      const top = ch.buf[0];
      const popped: Store = { vars: store.vars, chans: { ...store.chans, [key]: { size: ch.size, buf: ch.buf.slice(1) } } };
      const r = receive(top, popped);
      if (!r) return [];
      return [{ label: { kind: "ev", name: `${key}?${top.join(".")}` }, next: r.next, store: r.store, atomic: false, dataOp: true }];
    }
  }
}

/**
 * Match `c?x.1.y` against received values. A bare identifier that is not
 * already bound (parameter, earlier input, global, constant) binds; anything
 * else is evaluated and must be equal. Globals may not appear (PAT rule).
 */
function matchInput(pats: Expr[], guard: Expr | undefined, vals: Scalar[], env: Env, store: Store, ctx: Ctx): Env | null {
  if (pats.length !== vals.length) return null;
  const bound: Env = { ...env };
  for (let i = 0; i < pats.length; i++) {
    const p = pats[i];
    if (p.k === "id" && !(p.name in bound) && !(p.name in store.vars) && !ctx.spec.defines.has(p.name)) {
      bound[p.name] = vals[i];
      continue;
    }
    const v = evalExpr(p, bound, { vars: {}, chans: store.chans }, ctx);
    if (isArray(v) || v !== vals[i]) return null;
  }
  if (guard && !evalBool(guard, bound, { vars: {}, chans: store.chans }, ctx)) return null;
  return bound;
}

// ---------------------------------------------------------------------------
// Interleaving and alphabetised parallel
// ---------------------------------------------------------------------------

function compose(
  ps: RT[],
  sides: Move[][],
  alpha: Set<string>[] | null,
  mk: (ps: RT[]) => RT,
  store: Store,
): Move[] {
  const out: Move[] = [];
  const n = ps.length;
  const replace = (i: number, rt: RT): RT => {
    const c = ps.slice();
    c[i] = rt;
    return mk(c);
  };
  const isShared = (i: number, name: string) => {
    if (!alpha || !alpha[i].has(name)) return false;
    for (let j = 0; j < n; j++) if (j !== i && alpha[j].has(name)) return true;
    return false;
  };

  // Independent moves (interleave1/2, parallel1/2).
  for (let i = 0; i < n; i++) {
    for (const m of sides[i]) {
      switch (m.label.kind) {
        case "tick":
          break; // handled jointly below
        case "ev":
          if (!m.dataOp && isShared(i, m.label.name)) break; // handled jointly below
          out.push(wrap(m, (rt) => replace(i, rt)));
          break;
        default:
          out.push(wrap(m, (rt) => replace(i, rt)));
      }
    }
  }

  // Lock-step synchronisation on shared events (parallel3).
  if (alpha) {
    const names = new Set<string>();
    for (let i = 0; i < n; i++) {
      for (const m of sides[i]) {
        if (m.label.kind === "ev" && !m.dataOp && isShared(i, m.label.name)) names.add(m.label.name);
      }
    }
    for (const name of names) {
      const parts: number[] = [];
      for (let i = 0; i < n; i++) if (alpha[i].has(name)) parts.push(i);
      const options = parts.map((i) => sides[i].filter((m) => m.label.kind === "ev" && m.label.name === name && !m.dataOp));
      if (options.some((o) => o.length === 0)) continue;
      for (const combo of cartesian(options)) {
        const c = ps.slice();
        parts.forEach((i, k) => (c[i] = combo[k].next));
        out.push({ label: { kind: "ev", name }, next: mk(c), store, atomic: combo.some((m) => m.atomic), dataOp: false });
      }
    }
  }

  // Termination: every component must terminate together (interleave3).
  const ticks = sides.map((ms) => ms.find((m) => m.label.kind === "tick"));
  if (ticks.every((t) => t !== undefined)) {
    out.push({ label: { kind: "tick" }, next: mk(ticks.map((t) => t!.next)), store, atomic: ticks.some((t) => t!.atomic), dataOp: false });
  }

  // Synchronous channel handshakes: pair an output with an input elsewhere.
  for (let i = 0; i < n; i++) {
    for (const o of sides[i]) {
      if (o.label.kind !== "offer-out") continue;
      const chan = o.label.chan;
      const vals = o.label.vals;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        for (const r of sides[j]) {
          if (r.label.kind !== "offer-in" || r.label.chan !== chan || !r.recv) continue;
          const got = r.recv(vals, o.store); // sender's program runs first, then the receiver's
          if (!got) continue;
          const c = ps.slice();
          c[i] = o.next;
          c[j] = got.next;
          out.push({ label: { kind: "ev", name: `${chan}.${vals.join(".")}` }, next: mk(c), store: got.store, atomic: o.atomic || r.atomic, dataOp: true });
        }
      }
    }
  }

  return out;
}

function cartesian<T>(lists: T[][]): T[][] {
  let acc: T[][] = [[]];
  for (const l of lists) {
    const next: T[][] = [];
    for (const a of acc) for (const x of l) next.push([...a, x]);
    acc = next;
    if (acc.length > 10_000) throw new CspError("too many synchronisation combinations");
  }
  return acc;
}

