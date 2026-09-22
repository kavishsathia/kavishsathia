/**
 * SMT-LIB → math notation, for the notation toggle. Works from the
 * normalized clauses, so it succeeds exactly when every assert is a Horn
 * clause over int/real/bool that the math notation can express. Comments
 * don't survive the trip.
 */

import { parameterNames } from "./solve";
import { readProblem } from "./problem";
import { expandLets, head, type SExpr } from "./sexpr";

const SORTS: Record<string, string> = { Int: "int", Real: "real", Bool: "bool" };

// Binding power, matching the math parser.
const P = { iff: 1, implies: 2, or: 3, and: 4, cmp: 5, add: 6, mul: 7, unary: 8, atom: 9 };

class Unsupported extends Error {}

function name(t: string, rename: Map<string, string>): string {
  const r = rename.get(t);
  if (r) return r;
  if (/^[A-Za-z_][A-Za-z0-9_']*$/.test(t)) return t;
  throw new Unsupported(`the symbol ${t} has no math spelling`);
}

function term(e: SExpr, rename: Map<string, string>, preds: Set<string>): { s: string; p: number } {
  const w = (x: SExpr, min: number) => {
    const o = term(x, rename, preds);
    return o.p < min ? `(${o.s})` : o.s;
  };
  if (e.kind === "atom") {
    if (/^\d+(\.\d+)?$/.test(e.text) || e.text === "true" || e.text === "false") return { s: e.text, p: P.atom };
    const bare = e.text.startsWith("|") && e.text.endsWith("|") ? e.text.slice(1, -1) : e.text;
    return { s: name(bare, rename), p: P.atom };
  }
  const op = head(e);
  const a = e.items.slice(1);
  if (op === null) throw new Unsupported("unexpected term");
  if (preds.has(op)) return { s: `${op}(${a.map((x) => term(x, rename, preds).s).join(", ")})`, p: P.atom };
  const nary = (sym: string, prec: number) => ({
    s: a.map((x, i) => w(x, i === 0 ? prec : prec + 1)).join(` ${sym} `),
    p: prec,
  });
  switch (op) {
    case "and":
      return a.length === 0 ? { s: "true", p: P.atom } : a.length === 1 ? term(a[0], rename, preds) : nary("&&", P.and);
    case "or":
      return a.length === 0 ? { s: "false", p: P.atom } : a.length === 1 ? term(a[0], rename, preds) : nary("||", P.or);
    case "not":
      if (head(a[0]) === "=" && a[0].kind === "list" && a[0].items.length === 3) {
        return { s: `${w(a[0].items[1], P.cmp + 1)} != ${w(a[0].items[2], P.cmp + 1)}`, p: P.cmp };
      }
      return { s: `!${w(a[0], P.unary)}`, p: P.unary };
    case "=>":
      return { s: `${w(a[0], P.implies + 1)} ==> ${w(a[1], P.implies)}`, p: P.implies };
    case "=":
    case "<=":
    case ">=":
    case "<":
    case ">":
      if (a.length !== 2) throw new Unsupported(`chained ${op}`);
      return { s: `${w(a[0], P.cmp + 1)} ${op === "=" ? "==" : op} ${w(a[1], P.cmp + 1)}`, p: P.cmp };
    case "distinct":
      if (a.length !== 2) throw new Unsupported("distinct over more than two terms");
      return { s: `${w(a[0], P.cmp + 1)} != ${w(a[1], P.cmp + 1)}`, p: P.cmp };
    case "+":
      return nary("+", P.add);
    case "-":
      return a.length === 1 ? { s: `-${w(a[0], P.unary)}`, p: P.unary } : nary("-", P.add);
    case "*":
      return nary("*", P.mul);
    case "div":
    case "/":
      return nary("/", P.mul);
    case "mod":
      return nary("%", P.mul);
    case "ite":
      return {
        s: `if ${term(a[0], rename, preds).s} then ${term(a[1], rename, preds).s} else ${term(a[2], rename, preds).s}`,
        p: 0,
      };
    default:
      throw new Unsupported(`${op} has no math spelling`);
  }
}

export type ConvertResult = { ok: true; text: string } | { ok: false; reason: string };

export function smtToMath(src: string): ConvertResult {
  const read = readProblem(src);
  if (!read.ok) return { ok: false, reason: read.errors[0]?.message ?? "the SMT-LIB doesn't parse" };
  const { problem } = read;
  try {
    const predSet = new Set(problem.preds.keys());
    const out: string[] = [];
    for (const d of problem.preds.values()) {
      const names = parameterNames(problem, d.name, d.sorts.length);
      const params = d.sorts.map((s, i) => {
        if (!(s in SORTS)) throw new Unsupported(`the sort ${s} has no math spelling`);
        return `${names[i]}: ${SORTS[s]}`;
      });
      name(d.name, new Map());
      out.push(params.length > 0 ? `pred ${d.name}(${params.join(", ")})` : `pred ${d.name}`);
    }
    out.push("");
    for (const c of problem.clauses) {
      if (!c) throw new Unsupported("an assert isn't in Horn clause form");
      // Variables become implicit; rename any that collide with a predicate
      // or keyword.
      const rename = new Map<string, string>();
      for (const v of c.vars) {
        if (!(v.sort in SORTS)) throw new Unsupported(`the sort ${v.sort} has no math spelling`);
        const bare = v.name.startsWith("|") ? v.name.slice(1, -1) : v.name;
        let n = /^[A-Za-z_][A-Za-z0-9_']*$/.test(bare) ? bare : bare.replace(/[^A-Za-z0-9_']/g, "_").replace(/^[^A-Za-z_]/, "v");
        while (predSet.has(n) || ["if", "then", "else", "and", "or", "not", "true", "false", "pred", "predicate"].includes(n)) n += "_";
        rename.set(v.name, n);
        rename.set(bare, n);
      }
      const parts = [
        ...c.body.map((b) => (b.args.length === 0 ? b.pred : `${b.pred}(${b.args.map((x) => term(expandLets(x), rename, predSet).s).join(", ")})`)),
        ...c.constraints.map((x) => {
          const t = term(expandLets(x), rename, predSet);
          return t.p <= P.or ? `(${t.s})` : t.s;
        }),
      ];
      const hd = c.head
        ? c.head.args.length === 0
          ? c.head.pred
          : `${c.head.pred}(${c.head.args.map((x) => term(expandLets(x), rename, predSet).s).join(", ")})`
        : "false";
      out.push(parts.length === 0 ? hd : `${parts.join(" && ")} ==> ${hd}`);
    }
    return { ok: true, text: out.join("\n") + "\n" };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message };
    throw e;
  }
}
