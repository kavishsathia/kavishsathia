/**
 * Values, stores, and evaluation of the C#-like sequential sublanguage that
 * CSP# attaches to events. PAT is weakly typed: values are integers,
 * booleans, and fixed-size arrays (multi-dimensional arrays flattened, as PAT
 * does). Stores are immutable; running a block returns a new store.
 */

import {
  CspError,
  type Block,
  type Expr,
  type Loc,
  type Range,
  type Spec,
  type Stmt,
} from "./ast";

export type Scalar = number | boolean;
export type ArrayVal = { dims: number[]; data: Scalar[] };
export type Value = Scalar | ArrayVal;

export type ChanState = { size: number; buf: Scalar[][] };
export type Store = {
  vars: Record<string, Value>;
  chans: Record<string, ChanState>;
};

/** Process parameters and channel-input variables: read-only bindings. */
export type Env = Record<string, Value>;

export type Ctx = {
  spec: Spec;
  ranges: Record<string, { lo?: number; hi?: number }>;
};

export class CspRuntimeError extends CspError {
  constructor(message: string, loc?: Loc) {
    super(message, loc);
    this.name = "CspRuntimeError";
  }
}

export function isArray(v: Value): v is ArrayVal {
  return typeof v === "object";
}

export function fmtValue(v: Value): string {
  if (isArray(v)) return `[${v.data.map(String).join(", ")}]`;
  return String(v);
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (isArray(a) || isArray(b)) {
    if (!isArray(a) || !isArray(b)) return false;
    return a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);
  }
  return a === b;
}

export function valueKey(v: Value): string {
  return isArray(v) ? `[${v.data.join(",")}]` : String(v);
}

export function storeKey(s: Store): string {
  const vs = Object.keys(s.vars)
    .sort()
    .map((k) => `${k}=${valueKey(s.vars[k])}`)
    .join(";");
  const cs = Object.keys(s.chans)
    .sort()
    .map((k) => `${k}=${s.chans[k].buf.map((t) => t.join(".")).join("|")}`)
    .join(";");
  return `${vs}#${cs}`;
}

export function envKey(env: Env): string {
  const ks = Object.keys(env);
  if (ks.length === 0) return "";
  return ks
    .sort()
    .map((k) => `${k}=${valueKey(env[k])}`)
    .join(",");
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const MAX_LOOP_ITERATIONS = 1_000_000;

function cloneArray(a: ArrayVal): ArrayVal {
  return { dims: a.dims.slice(), data: a.data.slice() };
}

/**
 * One evaluation over a (possibly mutable) copy of the globals. In "frozen"
 * mode (guards, conditions, event arguments) any assignment is an error, as
 * PAT forbids side effects there.
 */
class Evaluator {
  private locals: Map<string, Value>[] = [];
  /** Names of arrays already copied for writing in this evaluation. */
  private copied = new Set<string>();
  private macroDepth = 0;

  constructor(
    private ctx: Ctx,
    private env: Env,
    private vars: Record<string, Value>,
    private chans: Record<string, ChanState>,
    private frozen: boolean,
  ) {}

  // -- scopes ---------------------------------------------------------------

  pushScope() {
    this.locals.push(new Map());
  }
  popScope() {
    this.locals.pop();
  }
  declareLocal(name: string, v: Value, loc: Loc) {
    const top = this.locals[this.locals.length - 1];
    if (!top) throw new CspRuntimeError("local variable outside a block", loc);
    top.set(name, v);
  }

  private findLocal(name: string): Map<string, Value> | null {
    for (let i = this.locals.length - 1; i >= 0; i--) {
      if (this.locals[i].has(name)) return this.locals[i];
    }
    return null;
  }

  lookup(name: string, loc: Loc): Value {
    const l = this.findLocal(name);
    if (l) return l.get(name)!;
    if (name in this.env) return this.env[name];
    if (name in this.vars) return this.vars[name];
    const d = this.ctx.spec.defines.get(name);
    if (d) {
      if (d.params) throw new CspRuntimeError(`macro '${name}' takes parameters; use call(${name}, …)`, loc);
      return this.evalMacro(name, d.body, loc);
    }
    if (name in this.chans) throw new CspRuntimeError(`'${name}' is a channel, not a variable`, loc);
    throw new CspRuntimeError(`unknown variable '${name}'`, loc);
  }

  private evalMacro(name: string, body: { k: "expr"; e: Expr } | { k: "block"; b: Block }, loc: Loc): Value {
    if (++this.macroDepth > 64) throw new CspRuntimeError(`macro '${name}' is recursive`, loc);
    try {
      if (body.k === "expr") return this.eval(body.e);
      const v = this.runBlock(body.b);
      return v ?? 0;
    } finally {
      this.macroDepth--;
    }
  }

  private assignName(name: string, v: Value, loc: Loc) {
    if (this.frozen) throw new CspRuntimeError("assignments are not allowed in conditions or event arguments", loc);
    const l = this.findLocal(name);
    if (l) {
      l.set(name, v);
      return;
    }
    if (name in this.env) throw new CspRuntimeError(`'${name}' is a process parameter or channel input and cannot be updated`, loc);
    if (name in this.vars) {
      this.vars[name] = v;
      return;
    }
    throw new CspRuntimeError(`unknown variable '${name}'`, loc);
  }

  private flatIndex(arr: ArrayVal, idx: Expr[], name: string, loc: Loc): number {
    if (idx.length !== arr.dims.length) {
      throw new CspRuntimeError(
        `'${name}' has ${arr.dims.length} dimension(s) but ${idx.length} index(es) were given`,
        loc,
      );
    }
    let flat = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = this.evalInt(idx[k]);
      if (i < 0 || i >= arr.dims[k]) {
        throw new CspRuntimeError(`index ${i} out of range for '${name}' (size ${arr.dims[k]})`, loc);
      }
      flat = flat * arr.dims[k] + i;
    }
    return flat;
  }

  private assignIndex(name: string, idx: Expr[], v: Value, loc: Loc) {
    if (this.frozen) throw new CspRuntimeError("assignments are not allowed in conditions or event arguments", loc);
    if (isArray(v)) throw new CspRuntimeError("cannot store an array inside an array", loc);
    const l = this.findLocal(name);
    let arr: Value;
    if (l) arr = l.get(name)!;
    else if (name in this.env) throw new CspRuntimeError(`'${name}' is a process parameter and cannot be updated`, loc);
    else if (name in this.vars) arr = this.vars[name];
    else throw new CspRuntimeError(`unknown variable '${name}'`, loc);
    if (!isArray(arr)) throw new CspRuntimeError(`'${name}' is not an array`, loc);
    const flat = this.flatIndex(arr, idx, name, loc);
    if (l) {
      const c = cloneArray(arr);
      c.data[flat] = v;
      l.set(name, c);
    } else {
      if (!this.copied.has(name)) {
        this.vars[name] = cloneArray(arr);
        this.copied.add(name);
      }
      (this.vars[name] as ArrayVal).data[flat] = v;
    }
  }

  // -- expressions ----------------------------------------------------------

  evalInt(e: Expr): number {
    const v = this.eval(e);
    if (typeof v !== "number") throw new CspRuntimeError(`expected an integer but got ${fmtValue(v)}`, e.loc);
    return v;
  }

  evalBool(e: Expr): boolean {
    const v = this.eval(e);
    if (typeof v !== "boolean") throw new CspRuntimeError(`expected a boolean but got ${fmtValue(v)}`, e.loc);
    return v;
  }

  evalScalar(e: Expr): Scalar {
    const v = this.eval(e);
    if (isArray(v)) throw new CspRuntimeError("expected a scalar value but got an array", e.loc);
    return v;
  }

  eval(e: Expr): Value {
    switch (e.k) {
      case "int":
        return e.v;
      case "bool":
        return e.v;
      case "id":
        return this.lookup(e.name, e.loc);
      case "index": {
        const arr = this.lookup(e.name, e.loc);
        if (!isArray(arr)) throw new CspRuntimeError(`'${e.name}' is not an array`, e.loc);
        return arr.data[this.flatIndex(arr, e.idx, e.name, e.loc)];
      }
      case "unary": {
        if (e.op === "!") return !this.evalBool(e.e);
        const v = this.evalInt(e.e);
        return e.op === "-" ? -v : v;
      }
      case "postfix": {
        const t = e.target;
        const cur = this.eval(t);
        if (typeof cur !== "number") throw new CspRuntimeError("++/-- need an integer variable", e.loc);
        const nv = cur + e.delta;
        if (t.k === "id") this.assignName(t.name, nv, e.loc);
        else if (t.k === "index") this.assignIndex(t.name, t.idx, nv, e.loc);
        return nv; // PAT: y = x++ is x = x + 1; y = x
      }
      case "assign": {
        const v = this.eval(e.value);
        const t = e.target;
        if (t.k === "id") this.assignName(t.name, v, e.loc);
        else if (t.k === "index") this.assignIndex(t.name, t.idx, v, e.loc);
        return v;
      }
      case "bin":
        return this.evalBin(e);
      case "call":
        return this.evalCall(e);
      case "indexed": {
        const bindings = expandRanges(e.ranges, (x) => this.evalInt(x), e.loc);
        let acc = e.op === "&&";
        for (const b of bindings) {
          this.pushScope();
          for (const [k, v] of Object.entries(b)) this.declareLocal(k, v, e.loc);
          const v = this.evalBool(e.body);
          this.popScope();
          if (e.op === "&&") acc = acc && v;
          else if (e.op === "||") acc = acc || v;
          else acc = acc !== v;
        }
        return acc;
      }
      case "record": {
        const data: Scalar[] = [];
        for (const el of e.elems) {
          if (el.kind === "span") {
            const a = this.evalInt(el.from);
            const b = this.evalInt(el.to);
            if (a <= b) for (let i = a; i <= b; i++) data.push(i);
            else for (let i = a; i >= b; i--) data.push(i);
          } else {
            const v = this.evalScalar(el.e);
            const n = el.count ? this.evalInt(el.count) : 1;
            for (let i = 0; i < n; i++) data.push(v);
          }
        }
        return { dims: [data.length], data };
      }
    }
  }

  private evalBin(e: Extract<Expr, { k: "bin" }>): Value {
    switch (e.op) {
      case "||":
        return this.evalBool(e.l) || this.evalBool(e.r);
      case "&&":
        return this.evalBool(e.l) && this.evalBool(e.r);
      case "xor":
        return this.evalBool(e.l) !== this.evalBool(e.r);
      case "==":
        return valuesEqual(this.eval(e.l), this.eval(e.r));
      case "!=":
        return !valuesEqual(this.eval(e.l), this.eval(e.r));
    }
    const a = this.eval(e.l);
    const b = this.eval(e.r);
    if (typeof a === "boolean" && typeof b === "boolean") {
      switch (e.op) {
        case "&": return a && b;
        case "|": return a || b;
        case "^": return a !== b;
      }
    }
    if (typeof a !== "number" || typeof b !== "number") {
      throw new CspRuntimeError(`'${e.op}' needs integer operands, got ${fmtValue(a)} and ${fmtValue(b)}`, e.loc);
    }
    switch (e.op) {
      case "<": return a < b;
      case ">": return a > b;
      case "<=": return a <= b;
      case ">=": return a >= b;
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/":
        if (b === 0) throw new CspRuntimeError("division by zero", e.loc);
        return Math.trunc(a / b);
      case "%":
        // PAT's own dining-philosophers example relies on (0-1)%N being N-1
        // (its documented deadlock needs it), so this is a floored modulo
        // rather than C#'s truncated remainder.
        if (b === 0) throw new CspRuntimeError("division by zero", e.loc);
        return ((a % b) + b) % b;
      case "&": return a & b;
      case "|": return a | b;
      case "^": return a ^ b;
    }
  }

  private chanArg(e: Extract<Expr, { k: "call" }>): ChanState {
    const a = e.args[0];
    if (!a || a.k !== "id") throw new CspRuntimeError(`call(${e.name}, c) needs a channel name`, e.loc);
    const ch = this.chans[a.name];
    if (!ch) throw new CspRuntimeError(`'${a.name}' is not a declared channel`, a.loc);
    if (ch.size === 0) throw new CspRuntimeError(`${e.name} cannot be applied to synchronous channel '${a.name}'`, a.loc);
    return ch;
  }

  private evalCall(e: Extract<Expr, { k: "call" }>): Value {
    switch (e.name) {
      case "cfull": {
        const c = this.chanArg(e);
        return c.buf.length >= c.size;
      }
      case "cempty":
        return this.chanArg(e).buf.length === 0;
      case "ccount":
        return this.chanArg(e).buf.length;
      case "csize":
        return this.chanArg(e).size;
      case "cpeek": {
        const c = this.chanArg(e);
        if (c.buf.length === 0) throw new CspRuntimeError("cpeek on an empty channel", e.loc);
        const top = c.buf[0];
        return top.length === 1 ? top[0] : { dims: [top.length], data: top.slice() };
      }
    }
    const d = this.ctx.spec.defines.get(e.name);
    if (!d) throw new CspRuntimeError(`unknown function or macro '${e.name}'`, e.loc);
    const params = d.params ?? [];
    if (params.length !== e.args.length) {
      throw new CspRuntimeError(`macro '${e.name}' expects ${params.length} argument(s), got ${e.args.length}`, e.loc);
    }
    const args = e.args.map((a) => this.eval(a));
    this.pushScope();
    params.forEach((p, i) => this.declareLocal(p, args[i], e.loc));
    try {
      return this.evalMacro(e.name, d.body, e.loc);
    } finally {
      this.popScope();
    }
  }

  // -- statements -----------------------------------------------------------

  runBlock(b: Block): Value | undefined {
    this.pushScope();
    try {
      for (const s of b.stmts) this.exec(s);
      return b.tail ? this.eval(b.tail) : undefined;
    } finally {
      this.popScope();
    }
  }

  private exec(s: Stmt) {
    switch (s.k) {
      case "block":
        this.runBlock(s.block);
        return;
      case "local": {
        let v: Value;
        if (s.dims) {
          const dims = s.dims.map((d) => this.evalInt(d));
          const n = dims.reduce((a, b) => a * b, 1);
          v = { dims, data: new Array(n).fill(0) };
          if (s.init) {
            const init = this.eval(s.init);
            if (!isArray(init)) throw new CspRuntimeError("array initialiser must be an array", s.loc);
            v = { dims, data: init.data.slice(0, n).concat(new Array(Math.max(0, n - init.data.length)).fill(0)) };
          }
        } else {
          v = s.init ? this.eval(s.init) : 0;
        }
        this.declareLocal(s.name, v, s.loc);
        return;
      }
      case "if":
        if (this.evalBool(s.cond)) this.exec(s.then);
        else if (s.else) this.exec(s.else);
        return;
      case "while": {
        let n = 0;
        while (this.evalBool(s.cond)) {
          this.exec(s.body);
          if (++n > MAX_LOOP_ITERATIONS) throw new CspRuntimeError("while loop did not terminate", s.loc);
        }
        return;
      }
      case "expr":
        this.eval(s.e);
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Evaluate a side-effect-free expression in a process context. */
export function evalExpr(e: Expr, env: Env, store: Store, ctx: Ctx): Value {
  return new Evaluator(ctx, env, store.vars, store.chans, true).eval(e);
}

export function evalInt(e: Expr, env: Env, store: Store, ctx: Ctx): number {
  return new Evaluator(ctx, env, store.vars, store.chans, true).evalInt(e);
}

export function evalBool(e: Expr, env: Env, store: Store, ctx: Ctx): boolean {
  return new Evaluator(ctx, env, store.vars, store.chans, true).evalBool(e);
}

/** Run a statement block attached to an event, returning the new store. */
export function runBlock(b: Block, env: Env, store: Store, ctx: Ctx): Store {
  const vars = { ...store.vars };
  const ev = new Evaluator(ctx, env, vars, store.chans, false);
  ev.runBlock(b);
  const next = { vars, chans: store.chans };
  checkRanges(next, ctx, b.loc);
  return next;
}

export function checkRanges(store: Store, ctx: Ctx, loc?: Loc) {
  for (const [name, r] of Object.entries(ctx.ranges)) {
    const v = store.vars[name];
    if (v === undefined) continue;
    const xs = isArray(v) ? v.data : [v];
    for (const x of xs) {
      if (typeof x !== "number") continue;
      if ((r.lo !== undefined && x < r.lo) || (r.hi !== undefined && x > r.hi)) {
        throw new CspRuntimeError(
          `variable '${name}' = ${x} is outside its declared range {${r.lo ?? ""}..${r.hi ?? ""}}`,
          loc,
        );
      }
    }
  }
}

/** Expand `x:{0..2}; y:{1,3}` into every binding, in order. */
export function expandRanges(
  ranges: Range[],
  evalI: (e: Expr) => number,
  loc: Loc,
): Record<string, number>[] {
  let out: Record<string, number>[] = [{}];
  for (const r of ranges) {
    let values: number[];
    if (r.kind === "range") {
      const a = evalI(r.from);
      const b = evalI(r.to);
      values = [];
      if (a <= b) for (let i = a; i <= b; i++) values.push(i);
      else for (let i = a; i >= b; i--) values.push(i);
    } else {
      values = r.items.map(evalI);
    }
    if (out.length * values.length > 100_000) throw new CspRuntimeError("indexed range is too large", loc);
    const next: Record<string, number>[] = [];
    for (const b of out) for (const v of values) next.push({ ...b, [r.v]: v });
    out = next;
  }
  return out;
}

/** Build the initial store from the declarations. */
export function initialStore(spec: Spec): { store: Store; ctx: Ctx } {
  const ctx: Ctx = { spec, ranges: {} };
  const vars: Record<string, Value> = {};
  const chans: Record<string, ChanState> = {};
  const empty: Store = { vars, chans };

  for (const d of spec.vars) {
    const ev = new Evaluator(ctx, {}, vars, chans, true);
    let v: Value;
    if (d.dims) {
      const dims = d.dims.map((x) => ev.evalInt(x));
      const n = dims.reduce((a, b) => a * b, 1);
      const data: Scalar[] = new Array(n).fill(0);
      if (d.init) {
        const init = ev.eval(d.init);
        if (!isArray(init)) throw new CspRuntimeError(`'${d.name}' is an array; its initial value must be an array`, d.loc);
        for (let i = 0; i < Math.min(n, init.data.length); i++) data[i] = init.data[i];
      }
      v = { dims, data };
    } else {
      v = d.init ? ev.eval(d.init) : 0;
    }
    vars[d.name] = v;
    if (d.range) {
      ctx.ranges[d.name] = {
        lo: d.range.lo ? ev.evalInt(d.range.lo) : undefined,
        hi: d.range.hi ? ev.evalInt(d.range.hi) : undefined,
      };
    }
  }

  for (const c of spec.channels) {
    const size = evalInt(c.size, {}, empty, ctx);
    if (size < 0) throw new CspRuntimeError(`channel '${c.name}' has negative buffer size`, c.loc);
    if (c.count) {
      const n = evalInt(c.count, {}, empty, ctx);
      for (let i = 0; i < n; i++) chans[`${c.name}[${i}]`] = { size, buf: [] };
      chans[c.name] = { size, buf: [] }; // lets call(cfull, c) resolve the base name
    } else {
      chans[c.name] = { size, buf: [] };
    }
  }

  checkRanges(empty, ctx);
  return { store: { vars, chans }, ctx };
}
