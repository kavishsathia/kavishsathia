/**
 * SMT-LIB terms as math: Spacer's invariants come back as
 * (not (<= (+ (* 2 x!0) (* (- 1) x!1)) (- 1))) and should read 2·x − y > −1.
 * Anything unfamiliar falls back to prefix notation for that subterm.
 */

import { atom, expandLets, head, isAtom, print, type SExpr } from "./sexpr";

// Binding power: higher binds tighter.
const PREC = {
  iff: 1,
  implies: 2,
  or: 3,
  and: 4,
  not: 5,
  cmp: 6,
  add: 7,
  mul: 8,
  neg: 9,
  atom: 10,
} as const;

type Out = { text: string; prec: number };

const CMP: Record<string, string> = {
  "=": "=",
  "<=": "≤",
  ">=": "≥",
  "<": "<",
  ">": ">",
  distinct: "≠",
};

// ¬(a ≤ b) is a > b, and so on — Z3 prints nearly every strict bound this way.
const NEGATED_CMP: Record<string, string> = {
  "<=": ">",
  ">=": "<",
  "<": "≥",
  ">": "≤",
  "=": "≠",
  distinct: "=",
};

function wrap(o: Out, min: number): string {
  return o.prec < min ? `(${o.text})` : o.text;
}

/** A literal integer/decimal, including Z3's (- 3). */
function numeral(e: SExpr): string | null {
  if (e.kind === "atom" && /^\d+(\.\d+)?$/.test(e.text)) return e.text;
  if (head(e) === "-" && e.kind === "list" && e.items.length === 2) {
    const inner = numeral(e.items[1]);
    if (inner !== null && !inner.startsWith("−")) return "−" + inner;
  }
  if (head(e) === "/" && e.kind === "list" && e.items.length === 3) {
    const a = numeral(e.items[1]);
    const b = numeral(e.items[2]);
    if (a !== null && b !== null) return `${a}/${b}`;
  }
  return null;
}

function symbolText(t: string): string {
  if (t.startsWith("|") && t.endsWith("|")) return t.slice(1, -1);
  return t;
}

function fmt(e: SExpr): Out {
  const num = numeral(e);
  if (num !== null) return { text: num, prec: num.startsWith("−") ? PREC.neg : PREC.atom };
  if (e.kind === "atom") {
    if (e.text === "true") return { text: "true", prec: PREC.atom };
    if (e.text === "false") return { text: "false", prec: PREC.atom };
    return { text: symbolText(e.text), prec: PREC.atom };
  }
  const op = head(e);
  const args = e.items.slice(1);
  if (op === null) return prefix(e);

  switch (op) {
    case "and":
    case "or": {
      if (args.length === 0) return { text: op === "and" ? "true" : "false", prec: PREC.atom };
      if (args.length === 1) return fmt(args[0]);
      const p = op === "and" ? PREC.and : PREC.or;
      return {
        text: args.map((a) => wrap(fmt(a), p + 1)).join(op === "and" ? " ∧ " : " ∨ "),
        prec: p,
      };
    }
    case "not": {
      const inner = args[0];
      const iop = inner && head(inner);
      if (iop && iop in NEGATED_CMP && inner.kind === "list" && inner.items.length === 3) {
        return cmp(NEGATED_CMP[iop], inner.items[1], inner.items[2]);
      }
      return { text: "¬" + wrap(fmt(inner), PREC.not), prec: PREC.not };
    }
    case "=>": {
      if (args.length < 2) return prefix(e);
      const parts = args.map((a, i) => wrap(fmt(a), i === args.length - 1 ? PREC.implies : PREC.implies + 1));
      return { text: parts.join(" ⇒ "), prec: PREC.implies };
    }
    case "=":
      if (args.length === 2 && isBoolish(args[0]) && isBoolish(args[1])) {
        return { text: `${wrap(fmt(args[0]), PREC.iff + 1)} ⇔ ${wrap(fmt(args[1]), PREC.iff + 1)}`, prec: PREC.iff };
      }
    // falls through
    case "<=":
    case ">=":
    case "<":
    case ">":
    case "distinct":
      if (args.length === 2) return cmp(CMP[op], args[0], args[1]);
      if (args.length > 2 && op !== "distinct") {
        // Chains: (<= a b c) is a ≤ b ≤ c.
        return {
          text: args.map((a) => wrap(fmt(a), PREC.cmp + 1)).join(` ${CMP[op]} `),
          prec: PREC.cmp,
        };
      }
      return prefix(e);
    case "+": {
      if (args.length === 0) return prefix(e);
      let text = wrap(fmt(args[0]), PREC.add);
      for (const a of args.slice(1)) {
        const neg = negatedTerm(a);
        if (neg) text += " − " + wrap(fmt(neg), PREC.add + 1);
        else {
          const f = fmt(a);
          if (f.text.startsWith("−")) text += " − " + f.text.slice(1);
          else text += " + " + wrap(f, PREC.add + 1);
        }
      }
      return { text, prec: PREC.add };
    }
    case "-": {
      if (args.length === 1) return { text: "−" + wrap(fmt(args[0]), PREC.neg), prec: PREC.neg };
      const parts = args.map((a, i) => wrap(fmt(a), i === 0 ? PREC.add : PREC.add + 1));
      return { text: parts.join(" − "), prec: PREC.add };
    }
    case "*": {
      if (args.length === 2) {
        const k = numeral(args[0]);
        if (k === "−1") return { text: "−" + wrap(fmt(args[1]), PREC.neg), prec: PREC.neg };
        if (k !== null && !k.includes("/")) {
          return { text: k + wrap(fmt(args[1]), PREC.neg), prec: PREC.mul };
        }
      }
      return { text: args.map((a) => wrap(fmt(a), PREC.mul + 1)).join("·"), prec: PREC.mul };
    }
    case "div":
    case "mod":
    case "/":
      if (args.length === 2) {
        const sym = op === "/" ? "/" : ` ${op} `;
        return { text: `${wrap(fmt(args[0]), PREC.mul)}${sym}${wrap(fmt(args[1]), PREC.mul + 1)}`, prec: PREC.mul };
      }
      return prefix(e);
    case "ite":
      if (args.length === 3) {
        return {
          text: `if ${fmt(args[0]).text} then ${fmt(args[1]).text} else ${fmt(args[2]).text}`,
          prec: 0,
        };
      }
      return prefix(e);
    case "forall":
    case "exists": {
      const binders = args[0];
      if (binders?.kind === "list" && args.length === 2) {
        const names = binders.items
          .map((b) => (b.kind === "list" && b.items[0] ? fmt(b.items[0]).text : "?"))
          .join(", ");
        return { text: `${op === "forall" ? "∀" : "∃"}${names}. ${fmt(args[1]).text}`, prec: 0 };
      }
      return prefix(e);
    }
    default:
      // Predicate / function application: f(a, b).
      return {
        text: `${symbolText(op)}(${args.map((a) => fmt(a).text).join(", ")})`,
        prec: PREC.atom,
      };
  }
}

/** Returns t when e is −t in one of Z3's spellings: (* (- 1) t) or (- t). */
function negatedTerm(e: SExpr): SExpr | null {
  if (e.kind !== "list") return null;
  if (head(e) === "*" && e.items.length === 3 && numeral(e.items[1]) === "−1") return e.items[2];
  if (head(e) === "-" && e.items.length === 2 && numeral(e) === null) return e.items[1];
  return null;
}

function isBoolish(e: SExpr): boolean {
  if (isAtom(e, "true") || isAtom(e, "false")) return true;
  const op = head(e);
  return op !== null && ["and", "or", "not", "=>", "<=", ">=", "<", ">", "distinct"].includes(op);
}

function cmp(sym: string, a: SExpr, b: SExpr): Out {
  return {
    text: `${wrap(fmt(a), PREC.cmp + 1)} ${sym} ${wrap(fmt(b), PREC.cmp + 1)}`,
    prec: PREC.cmp,
  };
}

function prefix(e: SExpr): Out {
  if (e.kind === "atom") return { text: e.text, prec: PREC.atom };
  return { text: "(" + e.items.map((x) => fmt(x).text).join(" ") + ")", prec: PREC.atom };
}

export function pretty(e: SExpr): string {
  return fmt(expandLets(e)).text;
}

/** Splits a top-level conjunction so invariants render one conjunct per line. */
export function conjuncts(e: SExpr): SExpr[] {
  const x = expandLets(e);
  if (head(x) === "and" && x.kind === "list" && x.items.length > 2) return x.items.slice(1);
  return [x];
}

// ── Integer tidying ─────────────────────────────────────────────────────
//
// Display-only rewrites that are sound over the integers, for invariants
// whose parameters are all Int:  ¬(a ≤ k) → a ≥ k+1,  a < k → a ≤ k−1,
// a ≤ k ∧ a ≥ k → a = k,  and x − y ≤ k → x ≤ y + k.

function intValue(e: SExpr): bigint | null {
  const n = numeral(e);
  if (n === null || n.includes(".") || n.includes("/")) return null;
  return BigInt(n.replace("−", "-"));
}

function intAtom(v: bigint): SExpr {
  return v < BigInt(0) ? { kind: "list", items: [atom("-"), atom((-v).toString())], start: -1, end: -1 } : atom(v.toString());
}

const FLIP: Record<string, string> = { "<=": ">", ">=": "<", "<": ">=", ">": "<=" };

function tidyCmp(op: string, a: SExpr, b: SExpr): SExpr {
  const k = intValue(b);
  if (k !== null) {
    if (op === "<") return mk("<=", a, intAtom(k - BigInt(1)));
    if (op === ">") return mk(">=", a, intAtom(k + BigInt(1)));
  }
  return mk(op, a, b);
}

function mk(op: string, ...args: SExpr[]): SExpr {
  return { kind: "list", items: [atom(op), ...args], start: -1, end: -1 };
}

function tidyNode(e: SExpr): SExpr {
  if (e.kind === "atom") return e;
  const op = head(e);
  const args = e.items.slice(1).map(tidyNode);
  if (op === "not" && args.length === 1) {
    const inner = args[0];
    const iop = head(inner);
    if (iop && iop in FLIP && inner.kind === "list" && inner.items.length === 3) {
      return tidyCmp(FLIP[iop], inner.items[1], inner.items[2]);
    }
    return mk("not", inner);
  }
  if ((op === "<" || op === ">") && args.length === 2) return tidyCmp(op, args[0], args[1]);
  if (op === "and") {
    // Pair up a ≤ k with a ≥ k.
    const out: SExpr[] = [];
    const used = new Set<number>();
    for (let i = 0; i < args.length; i++) {
      if (used.has(i)) continue;
      const x = args[i];
      const xop = head(x);
      if ((xop === "<=" || xop === ">=") && x.kind === "list" && x.items.length === 3) {
        const want = xop === "<=" ? ">=" : "<=";
        const j = args.findIndex(
          (y, jj) =>
            jj > i &&
            !used.has(jj) &&
            head(y) === want &&
            y.kind === "list" &&
            y.items.length === 3 &&
            print(y.items[1]) === print(x.items[1]) &&
            print(y.items[2]) === print(x.items[2]),
        );
        if (j >= 0) {
          used.add(j);
          out.push(mk("=", x.items[1], x.items[2]));
          continue;
        }
      }
      out.push(x);
    }
    return out.length === 1 ? out[0] : mk("and", ...out);
  }
  return { ...e, items: [e.items[0], ...args] };
}

/** Rebalances a comparison: pos − neg op k  →  pos op neg + k. */
function rebalance(e: SExpr): SExpr {
  if (e.kind === "atom") return e;
  const op = head(e);
  const items = e.items.map((x, i) => (i === 0 ? x : rebalance(x)));
  if (op && ["=", "<=", ">=", "<", ">"].includes(op) && items.length === 3) {
    const [, lhs, rhs] = items;
    const k = intValue(rhs);
    if (k !== null && head(lhs) === "+" && lhs.kind === "list") {
      const pos: SExpr[] = [];
      const neg: SExpr[] = [];
      for (const t of lhs.items.slice(1)) {
        const n = negatedTerm(t);
        const tk = numeral(t);
        if (n) neg.push(n);
        else if (tk !== null && tk.startsWith("−")) neg.push(atom(tk.slice(1)));
        else pos.push(t);
      }
      if (pos.length > 0 && neg.length > 0) {
        const right: SExpr[] = [...neg];
        if (k !== BigInt(0)) right.push(intAtom(k));
        const L = pos.length === 1 ? pos[0] : mk("+", ...pos);
        const R = right.length === 1 ? right[0] : mk("+", ...right);
        return mk(op, L, R);
      }
    }
  }
  return { ...e, items };
}

export function tidyInt(e: SExpr): SExpr {
  return rebalance(tidyNode(expandLets(e)));
}
