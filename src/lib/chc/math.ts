/**
 * A mathematical, Dafny-flavoured notation for CHC problems, compiled to the
 * SMT-LIB that Spacer reads:
 *
 *   pred inv(x: int, y: int)
 *
 *   x == 0 && y == 0 ==> inv(x, y)
 *   inv(x, y) && x' == x + 1 && y' == y + 2 ==> inv(x', y')
 *   inv(x, y) ==> y == 2 * x
 *
 * Each clause is one expression; its free variables are universally
 * quantified, with sorts inferred (int unless something says real or bool).
 * A clause ends where a line starts that can't continue the expression, so
 * long clauses can wrap freely. Operators take Dafny's spelling or the
 * Unicode one: && ∧ and, || ∨ or, ! ¬ not, ==> ⇒ =>, <==> ⇔, == =, != ≠,
 * <= ≤, >= ≥, and comparisons chain (0 <= i < n).
 */

export type MathDiagnostic = { start: number; end: number; message: string };

export type MathPred = { name: string; params: { name: string; sort: Sort }[] };

export type Compiled = {
  smt: string;
  preds: MathPred[];
  /** Source range of each clause, in assert order. */
  clauses: { start: number; end: number }[];
  /** 1-based SMT line of each clause's assert. */
  clauseLines: number[];
};

export type CompileResult =
  | { ok: true; compiled: Compiled }
  | { ok: false; errors: MathDiagnostic[] };

type Sort = "int" | "real" | "bool";

// ── Lexer ────────────────────────────────────────────────────────────────

type Tok = { t: string; kind: "num" | "id" | "op" | "eof"; start: number; end: number; nl: boolean };

const UNICODE: Record<string, string> = {
  "∧": "&&",
  "∨": "||",
  "¬": "!",
  "⇒": "==>",
  "→": "==>",
  "⇔": "<==>",
  "↔": "<==>",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
};

const OPS = ["<==>", "==>", "&&", "||", "==", "!=", "<=", ">=", "=>", "->", "::", "<", ">", "=", "!", "+", "-", "*", "/", "%", "(", ")", ",", ":", ";"];

const WORD_OPS: Record<string, string> = { and: "&&", or: "||", not: "!" };

function lex(src: string): { toks: Tok[]; errors: MathDiagnostic[] } {
  const toks: Tok[] = [];
  const errors: MathDiagnostic[] = [];
  let i = 0;
  let nl = true;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      nl = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      if (src.slice(i, stop).includes("\n")) nl = true;
      if (end < 0) errors.push({ start: i, end: i + 2, message: "unterminated /* comment" });
      i = stop;
      continue;
    }
    const start = i;
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      toks.push({ t: num[0], kind: "num", start, end: i, nl });
      nl = false;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_']*/.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      const w = id[0];
      if (w in WORD_OPS) toks.push({ t: WORD_OPS[w], kind: "op", start, end: i, nl });
      else toks.push({ t: w, kind: "id", start, end: i, nl });
      nl = false;
      continue;
    }
    if (c in UNICODE) {
      i++;
      toks.push({ t: UNICODE[c], kind: "op", start, end: i, nl });
      nl = false;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      i += op.length;
      const t = op === "=>" || op === "->" ? "==>" : op === "=" ? "==" : op;
      toks.push({ t, kind: "op", start, end: i, nl });
      nl = false;
      continue;
    }
    errors.push({ start: i, end: i + 1, message: `unexpected character ${JSON.stringify(c)}` });
    i++;
  }
  toks.push({ t: "", kind: "eof", start: src.length, end: src.length, nl: true });
  return { toks, errors };
}

// ── Parser ───────────────────────────────────────────────────────────────

type Expr = { start: number; end: number } & (
  | { k: "num"; text: string }
  | { k: "bool"; value: boolean }
  | { k: "var"; name: string }
  | { k: "app"; pred: string; args: Expr[] }
  | { k: "un"; op: "!" | "-"; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "chain"; ops: string[]; items: Expr[] }
  | { k: "ite"; c: Expr; t: Expr; e: Expr }
);

class SyntaxError_ extends Error {
  constructor(
    message: string,
    public start: number,
    public end: number,
  ) {
    super(message);
  }
}

const CMP_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

class Parser {
  i = 0;
  constructor(
    private toks: Tok[],
    private predNames: Set<string>,
  ) {}

  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  isOp(t: string): boolean {
    const p = this.peek();
    return p.kind === "op" && p.t === t;
  }
  expectOp(t: string): Tok {
    const p = this.peek();
    if (p.kind !== "op" || p.t !== t) {
      throw new SyntaxError_(`expected ${t}${p.kind === "eof" ? "" : ` before ${p.t}`}`, p.start, Math.max(p.end, p.start + 1));
    }
    return this.next();
  }

  expr(): Expr {
    if (this.peek().kind === "id" && this.peek().t === "if") return this.ite();
    return this.iff();
  }

  ite(): Expr {
    const start = this.next().start;
    const c = this.expr();
    this.expectWord("then");
    const t = this.expr();
    this.expectWord("else");
    const e = this.expr();
    return { k: "ite", c, t, e, start, end: e.end };
  }

  expectWord(w: string) {
    const p = this.peek();
    if (p.kind !== "id" || p.t !== w) throw new SyntaxError_(`expected ${w}`, p.start, Math.max(p.end, p.start + 1));
    this.next();
  }

  iff(): Expr {
    let l = this.implies();
    while (this.isOp("<==>")) {
      this.next();
      const r = this.implies();
      l = { k: "bin", op: "<==>", l, r, start: l.start, end: r.end };
    }
    return l;
  }

  implies(): Expr {
    const l = this.or();
    if (this.isOp("==>")) {
      this.next();
      const r = this.peek().kind === "id" && this.peek().t === "if" ? this.ite() : this.implies();
      return { k: "bin", op: "==>", l, r, start: l.start, end: r.end };
    }
    return l;
  }

  or(): Expr {
    let l = this.and();
    while (this.isOp("||")) {
      this.next();
      const r = this.and();
      l = { k: "bin", op: "||", l, r, start: l.start, end: r.end };
    }
    return l;
  }

  and(): Expr {
    let l = this.cmp();
    while (this.isOp("&&")) {
      this.next();
      const r = this.cmp();
      l = { k: "bin", op: "&&", l, r, start: l.start, end: r.end };
    }
    return l;
  }

  cmp(): Expr {
    const first = this.add();
    const items = [first];
    const ops: string[] = [];
    while (this.peek().kind === "op" && CMP_OPS.has(this.peek().t)) {
      ops.push(this.next().t);
      items.push(this.add());
    }
    if (ops.length === 0) return first;
    const end = items[items.length - 1].end;
    if (ops.length === 1) return { k: "bin", op: ops[0], l: items[0], r: items[1], start: first.start, end };
    return { k: "chain", ops, items, start: first.start, end };
  }

  add(): Expr {
    let l = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().t;
      const r = this.mul();
      l = { k: "bin", op, l, r, start: l.start, end: r.end };
    }
    return l;
  }

  mul(): Expr {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().t;
      const r = this.unary();
      l = { k: "bin", op, l, r, start: l.start, end: r.end };
    }
    return l;
  }

  unary(): Expr {
    if (this.isOp("!") || this.isOp("-")) {
      const tok = this.next();
      const e = this.unary();
      return { k: "un", op: tok.t as "!" | "-", e, start: tok.start, end: e.end };
    }
    return this.primary();
  }

  primary(): Expr {
    const tok = this.peek();
    if (tok.kind === "num") {
      this.next();
      return { k: "num", text: tok.t, start: tok.start, end: tok.end };
    }
    if (tok.kind === "op" && tok.t === "(") {
      this.next();
      const e = this.expr();
      const close = this.expectOp(")");
      return { ...e, start: tok.start, end: close.end };
    }
    if (tok.kind === "id") {
      if (tok.t === "true" || tok.t === "false") {
        this.next();
        return { k: "bool", value: tok.t === "true", start: tok.start, end: tok.end };
      }
      if (["if", "then", "else", "pred", "predicate"].includes(tok.t)) {
        throw new SyntaxError_(`unexpected ${tok.t}`, tok.start, tok.end);
      }
      this.next();
      const call = this.peek();
      // A call's ( must sit on the same line, so a clause starting with ( on
      // the next line isn't read as arguments.
      if (call.kind === "op" && call.t === "(" && !call.nl) {
        if (!this.predNames.has(tok.t)) {
          throw new SyntaxError_(
            `unknown predicate ${tok.t}: declare it first, like pred ${tok.t}(x: int)`,
            tok.start,
            tok.end,
          );
        }
        this.next();
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          args.push(this.expr());
          while (this.isOp(",")) {
            this.next();
            args.push(this.expr());
          }
        }
        const close = this.expectOp(")");
        return { k: "app", pred: tok.t, args, start: tok.start, end: close.end };
      }
      if (this.predNames.has(tok.t)) return { k: "app", pred: tok.t, args: [], start: tok.start, end: tok.end };
      return { k: "var", name: tok.t, start: tok.start, end: tok.end };
    }
    throw new SyntaxError_(
      tok.kind === "eof" ? "unexpected end of input" : `unexpected ${tok.t}`,
      tok.start,
      Math.max(tok.end, tok.start + 1),
    );
  }
}

// ── Sorts ────────────────────────────────────────────────────────────────

/** Union-find over sort variables; "num" is int-or-real, still open. */
type TVar = { parent: TVar | null; sort: Sort | "num" | null };

function find(v: TVar): TVar {
  while (v.parent) v = v.parent;
  return v;
}

function fresh(sort: Sort | "num" | null = null): TVar {
  return { parent: null, sort };
}

class TypeError_ extends Error {}

function meet(a: Sort | "num" | null, b: Sort | "num" | null): Sort | "num" | null {
  if (a === null) return b;
  if (b === null || a === b) return a;
  if (a === "num" && (b === "int" || b === "real")) return b;
  if (b === "num" && (a === "int" || a === "real")) return a;
  throw new TypeError_(`${show(a)} vs ${show(b)}`);
}

function show(s: Sort | "num" | null): string {
  return s === "num" ? "a number" : s === null ? "anything" : s;
}

function unify(a: TVar, b: TVar) {
  const ra = find(a);
  const rb = find(b);
  if (ra === rb) return;
  const sort = meet(ra.sort, rb.sort);
  rb.parent = ra;
  ra.sort = sort;
}

function resolved(v: TVar): Sort {
  const s = find(v).sort;
  return s === null || s === "num" ? "int" : s;
}

// ── Compiler ─────────────────────────────────────────────────────────────

const SMT_SORT: Record<Sort, string> = { int: "Int", real: "Real", bool: "Bool" };

function smtSymbol(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `|${name}|`;
}

type ClauseAst = { expr: Expr; start: number; end: number };

export function compileMath(src: string): CompileResult {
  const { toks, errors } = lex(src);
  const preds = new Map<string, MathPred>();
  const clauses: ClauseAst[] = [];

  // Pass 1: predicate declarations, so clauses can tell calls from variables
  // regardless of order.
  const predNames = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "id" && (t.t === "pred" || t.t === "predicate") && t.nl && toks[i + 1]?.kind === "id") {
      predNames.add(toks[i + 1].t);
    }
  }

  const p = new Parser(toks, predNames);
  const skipToNextLine = () => {
    p.next();
    while (p.peek().kind !== "eof" && !p.peek().nl) p.next();
  };

  while (p.peek().kind !== "eof") {
    const tok = p.peek();
    if (tok.kind === "op" && tok.t === ";") {
      p.next();
      continue;
    }
    try {
      if (tok.kind === "id" && (tok.t === "pred" || tok.t === "predicate")) {
        p.next();
        const nameTok = p.next();
        if (nameTok.kind !== "id") throw new SyntaxError_("expected a predicate name", nameTok.start, nameTok.end);
        if (preds.has(nameTok.t)) throw new SyntaxError_(`${nameTok.t} is already declared`, nameTok.start, nameTok.end);
        const params: { name: string; sort: Sort }[] = [];
        if (p.isOp("(") && !p.peek().nl) {
          p.next();
          while (!p.isOp(")")) {
            const pn = p.next();
            if (pn.kind !== "id") throw new SyntaxError_("expected a parameter name", pn.start, Math.max(pn.end, pn.start + 1));
            p.expectOp(":");
            const st = p.next();
            const sort = st.t.toLowerCase();
            if (st.kind !== "id" || !["int", "real", "bool"].includes(sort)) {
              throw new SyntaxError_("parameter sorts are int, real, or bool", st.start, Math.max(st.end, st.start + 1));
            }
            params.push({ name: pn.t, sort: sort as Sort });
            if (!p.isOp(")")) p.expectOp(",");
          }
          p.expectOp(")");
        }
        preds.set(nameTok.t, { name: nameTok.t, params });
      } else {
        if (!tok.nl && clauses.length > 0) {
          throw new SyntaxError_("expected the clause to end here (start the next clause on a new line)", tok.start, tok.end);
        }
        const expr = p.expr();
        clauses.push({ expr, start: expr.start, end: expr.end });
        const after = p.peek();
        if (after.kind !== "eof" && !after.nl && !(after.kind === "op" && after.t === ";")) {
          throw new SyntaxError_(`unexpected ${after.t}`, after.start, after.end);
        }
      }
    } catch (e) {
      if (!(e instanceof SyntaxError_)) throw e;
      errors.push({ start: e.start, end: e.end, message: e.message });
      skipToNextLine();
    }
  }

  // Sort inference and emission, clause by clause.
  const lines: string[] = ["(set-logic HORN)"];
  for (const pr of preds.values()) {
    lines.push(`(declare-fun ${smtSymbol(pr.name)} (${pr.params.map((x) => SMT_SORT[x.sort]).join(" ")}) Bool)`);
  }
  const clauseLines: number[] = [];

  for (const c of clauses) {
    const vars = new Map<string, TVar>();
    const order: string[] = [];
    const tv = new Map<Expr, TVar>();

    const infer = (e: Expr): TVar => {
      const v = inferInner(e);
      tv.set(e, v);
      return v;
    };
    const want = (e: Expr, sort: Sort | "num") => {
      const v = infer(e);
      try {
        unify(v, fresh(sort));
      } catch {
        throw new SyntaxError_(`expected ${show(sort)} here, found ${show(find(v).sort)}`, e.start, e.end);
      }
      return v;
    };
    const same = (a: Expr, b: Expr, at: Expr) => {
      const va = infer(a);
      const vb = infer(b);
      try {
        unify(va, vb);
      } catch (err) {
        throw new SyntaxError_(`mismatched sorts: ${(err as Error).message}`, at.start, at.end);
      }
      return va;
    };
    const inferInner = (e: Expr): TVar => {
      switch (e.k) {
        case "num":
          return fresh(e.text.includes(".") ? "real" : "num");
        case "bool":
          return fresh("bool");
        case "var": {
          if (!vars.has(e.name)) {
            vars.set(e.name, fresh());
            order.push(e.name);
          }
          return vars.get(e.name)!;
        }
        case "app": {
          const pr = preds.get(e.pred)!;
          if (pr.params.length !== e.args.length) {
            throw new SyntaxError_(
              `${e.pred} takes ${pr.params.length} argument${pr.params.length === 1 ? "" : "s"}, got ${e.args.length}`,
              e.start,
              e.end,
            );
          }
          e.args.forEach((a, i) => want(a, pr.params[i].sort));
          return fresh("bool");
        }
        case "un":
          if (e.op === "!") {
            want(e.e, "bool");
            return fresh("bool");
          }
          return want(e.e, "num");
        case "bin":
          if (["&&", "||", "==>", "<==>"].includes(e.op)) {
            want(e.l, "bool");
            want(e.r, "bool");
            return fresh("bool");
          }
          if (e.op === "==" || e.op === "!=") {
            same(e.l, e.r, e);
            return fresh("bool");
          }
          if (CMP_OPS.has(e.op)) {
            const v = same(e.l, e.r, e);
            try {
              unify(v, fresh("num"));
            } catch {
              throw new SyntaxError_(`${e.op} compares numbers`, e.start, e.end);
            }
            return fresh("bool");
          }
          {
            const v = same(e.l, e.r, e);
            try {
              unify(v, fresh(e.op === "%" ? "int" : "num"));
            } catch {
              throw new SyntaxError_(e.op === "%" ? "% is integer remainder" : `${e.op} needs numbers`, e.start, e.end);
            }
            return v;
          }
        case "chain":
          for (let i = 0; i < e.ops.length; i++) {
            const v = same(e.items[i], e.items[i + 1], e);
            if (e.ops[i] !== "==" && e.ops[i] !== "!=") {
              try {
                unify(v, fresh("num"));
              } catch {
                throw new SyntaxError_(`${e.ops[i]} compares numbers`, e.start, e.end);
              }
            }
          }
          return fresh("bool");
        case "ite": {
          want(e.c, "bool");
          return same(e.t, e.e, e);
        }
      }
    };

    try {
      want(c.expr, "bool");
    } catch (err) {
      if (err instanceof SyntaxError_) {
        errors.push({ start: err.start, end: err.end, message: err.message });
        continue;
      }
      throw err;
    }

    const emit = (e: Expr): string => {
      switch (e.k) {
        case "num": {
          const sort = resolved(tv.get(e)!);
          return sort === "real" && !e.text.includes(".") ? `${e.text}.0` : e.text;
        }
        case "bool":
          return e.value ? "true" : "false";
        case "var":
          return smtSymbol(e.name);
        case "app":
          return e.args.length === 0 ? smtSymbol(e.pred) : `(${smtSymbol(e.pred)} ${e.args.map(emit).join(" ")})`;
        case "un":
          return e.op === "!" ? `(not ${emit(e.e)})` : `(- ${emit(e.e)})`;
        case "bin": {
          const l = emit(e.l);
          const r = emit(e.r);
          switch (e.op) {
            case "&&":
              return `(and ${l} ${r})`;
            case "||":
              return `(or ${l} ${r})`;
            case "==>":
              return `(=> ${l} ${r})`;
            case "<==>":
            case "==":
              return `(= ${l} ${r})`;
            case "!=":
              return `(not (= ${l} ${r}))`;
            case "/":
              return resolved(tv.get(e)!) === "int" ? `(div ${l} ${r})` : `(/ ${l} ${r})`;
            case "%":
              return `(mod ${l} ${r})`;
            default:
              return `(${e.op} ${l} ${r})`;
          }
        }
        case "chain": {
          const parts = e.ops.map((op, i) => {
            const a = emit(e.items[i]);
            const b = emit(e.items[i + 1]);
            return op === "!=" ? `(not (= ${a} ${b}))` : `(${op === "==" ? "=" : op} ${a} ${b})`;
          });
          return `(and ${parts.join(" ")})`;
        }
        case "ite":
          return `(ite ${emit(e.c)} ${emit(e.t)} ${emit(e.e)})`;
      }
    };

    const body = emit(c.expr);
    const binders = order.map((n) => `(${smtSymbol(n)} ${SMT_SORT[resolved(vars.get(n)!)]})`).join(" ");
    lines.push(binders ? `(assert (forall (${binders}) ${body}))` : `(assert ${body})`);
    clauseLines.push(lines.length);
  }

  if (errors.length > 0) return { ok: false, errors };
  if (clauses.length === 0) {
    return { ok: false, errors: [{ start: 0, end: Math.min(1, src.length), message: "no clauses yet" }] };
  }
  lines.push("(check-sat)");
  return {
    ok: true,
    compiled: {
      smt: lines.join("\n") + "\n",
      preds: [...preds.values()],
      clauses: clauses.map((c) => ({ start: c.start, end: c.end })),
      clauseLines,
    },
  };
}
