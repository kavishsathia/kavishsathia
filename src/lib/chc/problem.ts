/**
 * Reads a CHC problem in the SMT-LIB 2 HORN format (the CHC-COMP input
 * language) and normalizes each assertion to
 *
 *   forall vars.  P1(t̄1) ∧ … ∧ Pk(t̄k) ∧ φ  ⇒  H
 *
 * where H is a predicate application or false. Z3 gets the user's text
 * as written; this structure is only used to explain Spacer's answers — which
 * clause fired at each counterexample step, what to name invariant
 * parameters — so a clause we can't normalize still gets solved.
 */

import {
  ParseError,
  atom,
  expandLets,
  head,
  isAtom,
  list,
  parseAll,
  print,
  type SExpr,
} from "./sexpr";

export type PredDecl = { name: string; sorts: string[] };
export type PredApp = { pred: string; args: SExpr[] };

export type Clause = {
  /** 1-based, in order of appearance. */
  index: number;
  start: number;
  end: number;
  vars: { name: string; sort: string }[];
  body: PredApp[];
  constraints: SExpr[];
  /** null means the head is false: a query. */
  head: PredApp | null;
};

export type Problem = {
  preds: Map<string, PredDecl>;
  /** One entry per assert; null where normalization gave up. */
  clauses: (Clause | null)[];
  assertRanges: { start: number; end: number }[];
  /**
   * The source with commands the driver issues itself (check-sat, get-model,
   * set-logic, …) blanked to spaces, so Z3's line:column errors still line up.
   */
  sanitized: string;
  /** Same, with predicate declarations and asserts blanked too. */
  declarationsOnly: string;
  hasSetLogic: boolean;
};

export type Diagnostic = { start: number; end: number; message: string };

export type ProblemResult =
  | { ok: true; problem: Problem; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[] };

const DRIVER_COMMANDS = new Set([
  "check-sat",
  "get-model",
  "get-proof",
  "get-info",
  "exit",
  "reset",
  "push",
  "pop",
  "check-sat-assuming",
  "get-value",
  "get-assertions",
]);

function blank(src: string, ranges: { start: number; end: number }[]): string {
  if (ranges.length === 0) return src;
  const chars = src.split("");
  for (const { start, end } of ranges) {
    for (let i = start; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("");
}

function flattenAnd(e: SExpr, out: SExpr[]) {
  if (head(e) === "and" && e.kind === "list") {
    for (const x of e.items.slice(1)) flattenAnd(x, out);
  } else if (!isAtom(e, "true")) {
    out.push(e);
  }
}

function asPredApp(e: SExpr, preds: Map<string, PredDecl>): PredApp | null {
  if (e.kind === "atom") return preds.has(e.text) ? { pred: e.text, args: [] } : null;
  const op = head(e);
  if (op && preds.has(op)) return { pred: op, args: e.items.slice(1) };
  return null;
}

function mentionsPred(e: SExpr, preds: Map<string, PredDecl>): boolean {
  if (e.kind === "atom") return preds.has(e.text);
  return e.items.some((x) => mentionsPred(x, preds));
}

function negate(e: SExpr): SExpr {
  if (head(e) === "not" && e.kind === "list" && e.items.length === 2) return e.items[1];
  return list(atom("not"), e);
}

function normalize(
  formula: SExpr,
  preds: Map<string, PredDecl>,
): Omit<Clause, "index" | "start" | "end"> | null {
  const vars: { name: string; sort: string }[] = [];
  let f = expandLets(formula);
  // Nested foralls, as some generators emit.
  for (;;) {
    if (head(f) === "forall" && f.kind === "list" && f.items[1]?.kind === "list") {
      for (const b of f.items[1].items) {
        if (b.kind !== "list" || b.items.length !== 2 || b.items[0].kind !== "atom") return null;
        vars.push({ name: b.items[0].text, sort: print(b.items[1]) });
      }
      f = f.items[2];
      continue;
    }
    break;
  }

  let bodyF: SExpr;
  let headF: SExpr;
  const op = head(f);
  if (op === "=>" && f.kind === "list" && f.items.length >= 3) {
    // (=> a b c) is right-associative: a ∧ b ⇒ c.
    bodyF = list(atom("and"), ...f.items.slice(1, -1));
    headF = f.items[f.items.length - 1];
  } else if (op === "not" && f.kind === "list" && f.items.length === 2) {
    bodyF = f.items[1];
    headF = atom("false");
  } else if (op === "or" && f.kind === "list") {
    // ¬P1 ∨ … ∨ ¬Pk ∨ ψ ∨ H with at most one positive predicate literal.
    const bodyParts: SExpr[] = [];
    const heads: SExpr[] = [];
    for (const lit of f.items.slice(1)) {
      if (head(lit) === "not" && lit.kind === "list") bodyParts.push(lit.items[1]);
      else if (asPredApp(lit, preds)) heads.push(lit);
      else if (mentionsPred(lit, preds)) return null;
      else bodyParts.push(negate(lit));
    }
    if (heads.length > 1) return null;
    bodyF = list(atom("and"), ...bodyParts);
    headF = heads[0] ?? atom("false");
  } else {
    bodyF = atom("true");
    headF = f;
  }

  const conjuncts: SExpr[] = [];
  flattenAnd(bodyF, conjuncts);

  let headApp: PredApp | null = null;
  if (!isAtom(headF, "false")) {
    headApp = asPredApp(headF, preds);
    if (!headApp) {
      // A constraint in head position is a query: B ∧ ¬ψ ⇒ false.
      if (mentionsPred(headF, preds)) return null;
      conjuncts.push(negate(headF));
    }
  }

  const body: PredApp[] = [];
  const constraints: SExpr[] = [];
  for (const c of conjuncts) {
    const app = asPredApp(c, preds);
    if (app) body.push(app);
    else if (mentionsPred(c, preds)) return null;
    else constraints.push(c);
  }
  return { vars, body, constraints, head: headApp };
}

export function readProblem(src: string): ProblemResult {
  let exprs: SExpr[];
  try {
    exprs = parseAll(src);
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, errors: [{ start: e.start, end: e.end, message: e.message }] };
    }
    throw e;
  }

  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const preds = new Map<string, PredDecl>();
  const driverRanges: { start: number; end: number }[] = [];
  const declRanges: { start: number; end: number }[] = [];
  const asserts: SExpr[] = [];
  let hasSetLogic = false;

  for (const e of exprs) {
    const op = head(e);
    if (e.kind !== "list" || !op) {
      errors.push({ start: e.start, end: e.end, message: "expected a command like (assert …)" });
      continue;
    }
    if (op === "set-logic") {
      const logic = e.items[1];
      if (!isAtom(logic, "HORN")) {
        errors.push({
          start: e.start,
          end: e.end,
          message: "Spacer solves the HORN logic — use (set-logic HORN)",
        });
      }
      hasSetLogic = true;
      driverRanges.push(e);
    } else if (op === "set-option" && isAtom(e.items[1], ":produce-proofs")) {
      driverRanges.push(e);
    } else if (DRIVER_COMMANDS.has(op)) {
      driverRanges.push(e);
    } else if (op === "declare-fun") {
      const [, name, sorts, range] = e.items;
      if (isAtom(name) && sorts?.kind === "list" && isAtom(range, "Bool")) {
        preds.set(name.text, { name: name.text, sorts: sorts.items.map(print) });
        declRanges.push(e);
      }
    } else if (op === "assert") {
      if (e.items.length !== 2) {
        errors.push({ start: e.start, end: e.end, message: "assert takes one formula" });
        continue;
      }
      asserts.push(e);
      declRanges.push(e);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const clauses: (Clause | null)[] = [];
  asserts.forEach((a, i) => {
    const formula = (a as { items: SExpr[] }).items[1];
    const norm = normalize(formula, preds);
    if (!norm) {
      warnings.push({
        start: a.start,
        end: a.end,
        message:
          "not in a shape this page can explain (Spacer still solves it); counterexample steps through it won't be attributed",
      });
      clauses.push(null);
      return;
    }
    clauses.push({ index: i + 1, start: a.start, end: a.end, ...norm });
  });

  const sanitized = blank(src, driverRanges);
  return {
    ok: true,
    warnings,
    problem: {
      preds,
      clauses,
      assertRanges: asserts.map((a) => ({ start: a.start, end: a.end })),
      sanitized,
      declarationsOnly: blank(sanitized, declRanges),
      hasSetLogic,
    },
  };
}
