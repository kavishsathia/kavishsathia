/**
 * Runs Z3's Spacer engine on a CHC problem and turns its answer into
 * something a reader can check:
 *
 *  - sat   → a model: one interpretation per predicate, i.e. inductive
 *            invariants / procedure summaries. We then re-check every clause
 *            under that model in a fresh context (each must be valid).
 *  - unsat → a hyper-resolution proof of false, i.e. a counterexample. We
 *            flatten it into ground derivation steps and, for each step, ask
 *            Z3 which of the user's clauses produces it from its premises.
 *
 * Spacer itself runs through Z3_eval_smtlib2_string on the user's text as
 * written (minus commands the driver issues), so line:column errors from Z3
 * point into the editor.
 */

import { readProblem, type Clause, type Diagnostic, type Problem } from "./problem";
import { atom, expandLets, head, isAtom, list, parseAll, print, substitute, type SExpr } from "./sexpr";

export type Z3Low = {
  mk_config(): unknown;
  del_config(cfg: unknown): void;
  mk_context(cfg: unknown): unknown;
  del_context(ctx: unknown): void;
  eval_smtlib2_string(ctx: unknown, smt: string): Promise<string>;
  interrupt(ctx: unknown): void;
};

export type Interpretation = {
  pred: string;
  params: { name: string; sort: string }[];
  /** SMT-LIB body with parameters renamed to the user's variable names. */
  body: SExpr;
};

export type Step = {
  /** Predicate name, or null for the final step that derives false. */
  pred: string | null;
  args: SExpr[];
  premises: number[];
  /** 1-based clause index, or null when no clause could be matched. */
  clause: number | null;
};

export type ClauseCheck = { clause: number; ok: boolean | null };

export type SolveOutcome =
  | { kind: "input-error"; errors: Diagnostic[] }
  | { kind: "z3-error"; errors: { line: number; column: number; message: string }[]; raw: string }
  | {
      kind: "sat";
      ms: number;
      interpretations: Interpretation[];
      checks: ClauseCheck[];
      raw: string;
      warnings: Diagnostic[];
    }
  | { kind: "unsat"; ms: number; steps: Step[]; raw: string; warnings: Diagnostic[] }
  | { kind: "unknown"; ms: number; reason: string; raw: string; warnings: Diagnostic[] }
  | { kind: "stopped" };

/**
 * Z3's CHC front end inlines predicates with a single definition before
 * Spacer sees them. Invariants and counterexamples for inlined predicates
 * would then be missing, so keep every predicate the user declared.
 */
const SPACER_OPTIONS = [
  "(set-option :produce-proofs true)",
  "(set-option :fp.xform.inline_eager false)",
  "(set-option :fp.xform.inline_linear false)",
].join("\n");

function newContext(z3: Z3Low): unknown {
  const cfg = z3.mk_config();
  const ctx = z3.mk_context(cfg);
  z3.del_config(cfg);
  return ctx;
}

const ERROR_RE = /\(error "line (\d+) column (\d+): ((?:[^"]|"")*)"\)/g;

function z3Errors(out: string) {
  const errors: { line: number; column: number; message: string }[] = [];
  for (const m of out.matchAll(ERROR_RE)) {
    errors.push({ line: Number(m[1]), column: Number(m[2]), message: m[3].replace(/""/g, '"') });
  }
  if (errors.length === 0 && out.includes("(error")) {
    errors.push({ line: 0, column: 0, message: out.trim() });
  }
  return errors;
}

export type SolveOptions = {
  timeoutMs?: number;
  /** Receives a function that stops this run (interrupting Z3). */
  onStart?: (stop: () => void) => void;
  /** Parameter names to show in interpretations, when the source has them. */
  paramNames?: Map<string, string[]>;
};

export async function solveChc(z3: Z3Low, source: string, options: SolveOptions = {}): Promise<SolveOutcome> {
  const read = readProblem(source);
  if (!read.ok) return { kind: "input-error", errors: read.errors };
  const { problem, warnings } = read;

  const ctx = newContext(z3);
  let stopped = false;
  let timedOut = false;
  const stop = () => {
    stopped = true;
    z3.interrupt(ctx);
  };
  options.onStart?.(stop);
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        z3.interrupt(ctx);
      }, options.timeoutMs)
    : null;

  try {
    // Z3's line counter keeps running across calls on one context, so the
    // setup's lines are subtracted from any error in the user's text.
    const prelude = SPACER_OPTIONS + "\n(set-logic HORN)\n";
    await z3.eval_smtlib2_string(ctx, prelude);
    const offset = prelude.split("\n").length - 1;
    const setup = await z3.eval_smtlib2_string(ctx, problem.sanitized);
    const setupErrors = z3Errors(setup).map((e) => (e.line > 0 ? { ...e, line: e.line - offset } : e));
    if (setupErrors.length > 0) return { kind: "z3-error", errors: setupErrors, raw: setup };

    const t0 = performance.now();
    const verdict = (await z3.eval_smtlib2_string(ctx, "(check-sat)")).trim();
    const ms = performance.now() - t0;
    if (stopped) return { kind: "stopped" };

    if (verdict === "sat") {
      const raw = await z3.eval_smtlib2_string(ctx, "(get-model)");
      const interpretations = readModel(raw, problem, options.paramNames);
      const checks = await checkModel(z3, problem, raw);
      return { kind: "sat", ms, interpretations, checks, raw, warnings };
    }
    if (verdict === "unsat") {
      const raw = await z3.eval_smtlib2_string(ctx, "(get-proof)");
      const steps = await readCounterexample(z3, problem, raw);
      return { kind: "unsat", ms, steps, raw, warnings };
    }
    if (verdict.startsWith("unknown")) {
      const info = await z3.eval_smtlib2_string(ctx, "(get-info :reason-unknown)");
      const m = /:reason-unknown "((?:[^"]|"")*)"/.exec(info);
      let reason = m ? m[1] : "no reason given";
      if (timedOut && /cancel/.test(reason)) reason = `stopped after ${Math.round(options.timeoutMs! / 1000)} s`;
      return { kind: "unknown", ms, reason, raw: verdict, warnings };
    }
    const errors = z3Errors(verdict);
    return {
      kind: "z3-error",
      errors: errors.length > 0 ? errors : [{ line: 0, column: 0, message: verdict }],
      raw: verdict,
    };
  } finally {
    if (timer) clearTimeout(timer);
    z3.del_context(ctx);
  }
}

// ── Models ───────────────────────────────────────────────────────────────

type DefineFun = { name: string; params: { name: string; sort: string }[]; body: SExpr };

function readDefineFuns(raw: string): DefineFun[] {
  let exprs: SExpr[];
  try {
    exprs = parseAll(raw);
  } catch {
    return [];
  }
  // (get-model) prints either ((define-fun …) …) or (model (define-fun …) …).
  const defs: SExpr[] = [];
  for (const e of exprs) {
    if (e.kind !== "list") continue;
    for (const item of e.items) if (head(item) === "define-fun") defs.push(item);
  }
  const out: DefineFun[] = [];
  for (const d of defs) {
    if (d.kind !== "list" || d.items.length !== 5) continue;
    const [, name, params, , body] = d.items;
    if (name.kind !== "atom" || params.kind !== "list") continue;
    out.push({
      name: name.text,
      params: params.items.flatMap((p) =>
        p.kind === "list" && p.items[0]?.kind === "atom" ? [{ name: p.items[0].text, sort: print(p.items[1]) }] : [],
      ),
      body,
    });
  }
  return out;
}

/**
 * Names for a predicate's parameters: the variables from the first clause
 * whose head is P(v1, …, vn) with n distinct variables, else from a body
 * occurrence, else x0, x1, ….
 */
export function parameterNames(problem: Problem, pred: string, arity: number): string[] {
  const fromApp = (args: SExpr[], vars: Set<string>) => {
    const names = args.map((a) => (a.kind === "atom" && vars.has(a.text) ? a.text : null));
    if (names.some((n) => n === null) || new Set(names).size !== names.length) return null;
    return names as string[];
  };
  const clauses = problem.clauses.filter((c): c is Clause => c !== null);
  for (const pass of ["head", "body"] as const) {
    for (const c of clauses) {
      const vars = new Set(c.vars.map((v) => v.name));
      const apps = pass === "head" ? (c.head ? [c.head] : []) : c.body;
      for (const app of apps) {
        if (app.pred !== pred || app.args.length !== arity) continue;
        const names = fromApp(app.args, vars);
        if (names) return names;
      }
    }
  }
  return Array.from({ length: arity }, (_, i) => `x${i}`);
}

function readModel(raw: string, problem: Problem, given?: Map<string, string[]>): Interpretation[] {
  const defs = new Map(readDefineFuns(raw).map((d) => [d.name, d]));
  const out: Interpretation[] = [];
  for (const decl of problem.preds.values()) {
    const d = defs.get(decl.name);
    const hinted = given?.get(decl.name);
    const names =
      hinted && hinted.length === decl.sorts.length ? hinted : parameterNames(problem, decl.name, decl.sorts.length);
    const params = decl.sorts.map((sort, i) => ({ name: names[i], sort }));
    if (!d) {
      // Z3 omits predicates it never needed; any interpretation works, and
      // false is the one it would pick.
      out.push({ pred: decl.name, params, body: atom("false") });
      continue;
    }
    const env = new Map<string, SExpr>();
    d.params.forEach((p, i) => env.set(p.name, atom(names[i] ?? p.name)));
    out.push({ pred: decl.name, params, body: substitute(expandLets(d.body), env) });
  }
  return out;
}

/**
 * Independent check of Spacer's model: define each predicate as its
 * interpretation and ask, per clause, whether its negation is satisfiable.
 * unsat means the clause holds for every assignment.
 */
async function checkModel(z3: Z3Low, problem: Problem, rawModel: string): Promise<ClauseCheck[]> {
  const defs = new Map(readDefineFuns(rawModel).map((d) => [d.name, d]));
  const ctx = newContext(z3);
  try {
    let script = "(set-logic ALL)\n" + problem.declarationsOnly + "\n";
    for (const decl of problem.preds.values()) {
      const d = defs.get(decl.name);
      const params = decl.sorts.map((s, i) => `(p!${i} ${s})`).join(" ");
      script += d
        ? `(define-fun ${d.name} (${d.params.map((p) => `(${p.name} ${p.sort})`).join(" ")}) Bool ${print(d.body)})\n`
        : `(define-fun ${decl.name} (${params}) Bool false)\n`;
    }
    const setup = await z3.eval_smtlib2_string(ctx, script);
    if (z3Errors(setup).length > 0) {
      return problem.assertRanges.map((_, i) => ({ clause: i + 1, ok: null }));
    }
    const exprs = parseAll(problem.sanitized).filter((e) => head(e) === "assert");
    const out: ClauseCheck[] = [];
    for (let i = 0; i < exprs.length; i++) {
      const formula = (exprs[i] as { items: SExpr[] }).items[1];
      const r = (
        await z3.eval_smtlib2_string(
          ctx,
          `(push 1)\n(assert (not ${print(formula)}))\n(check-sat)\n(pop 1)`,
        )
      ).trim();
      out.push({ clause: i + 1, ok: r === "unsat" ? true : r === "sat" ? false : null });
    }
    return out;
  } finally {
    z3.del_context(ctx);
  }
}

// ── Counterexamples ──────────────────────────────────────────────────────

type ProofNode =
  | { kind: "derive"; rule: ProofNode; premises: ProofNode[]; fact: SExpr }
  | { kind: "asserted"; formula: SExpr }
  | { kind: "mp"; parts: ProofNode[] }
  | { kind: "other"; parts: ProofNode[] };

/**
 * Evaluates Z3's proof term. Proofs share subproofs through `let` (names
 * like @x12 for proofs, $x7 for formulas); resolving names to evaluated
 * objects keeps that sharing, where textual let-expansion could blow up.
 */
function evalProof(e: SExpr, env: Map<string, ProofNode | SExpr>): ProofNode | SExpr {
  if (e.kind === "atom") return env.get(e.text) ?? e;
  const op = head(e);
  if (op === "let" && e.items[1]?.kind === "list") {
    const inner = new Map(env);
    for (const b of e.items[1].items) {
      if (b.kind === "list" && b.items.length === 2 && b.items[0].kind === "atom") {
        inner.set(b.items[0].text, evalProof(b.items[1], env));
      }
    }
    return evalProof(e.items[2], inner);
  }
  const first = e.items[0];
  const isHyperRes =
    first?.kind === "list" && isAtom(first.items[0], "_") && isAtom(first.items[1], "hyper-res");
  if (isHyperRes) {
    const parts = e.items.slice(1).map((x) => evalProof(x, env));
    const factPart = parts[parts.length - 1];
    return {
      kind: "derive",
      rule: asNode(parts[0]),
      premises: parts.slice(1, -1).map(asNode),
      fact: isProofNode(factPart) ? atom("?") : factPart,
    };
  }
  if (op === "asserted") {
    const f = evalProof(e.items[1], env);
    return { kind: "asserted", formula: isProofNode(f) ? atom("?") : f };
  }
  if (op === "mp") {
    return { kind: "mp", parts: e.items.slice(1).map((x) => asNode(evalProof(x, env))) };
  }
  // A plain term (a fact like (inv 1 3), or a formula): substitute names.
  return substituteTerms(e, env);
}

function substituteTerms(e: SExpr, env: Map<string, ProofNode | SExpr>): SExpr {
  if (e.kind === "atom") {
    const v = env.get(e.text);
    return v && !isProofNode(v) ? v : e;
  }
  return { ...e, items: e.items.map((x) => substituteTerms(x, env)) };
}

function isProofNode(x: ProofNode | SExpr): x is ProofNode {
  return (x as ProofNode).kind === "derive" || (x as ProofNode).kind === "asserted" ||
    (x as ProofNode).kind === "mp" || (x as ProofNode).kind === "other";
}

function asNode(x: ProofNode | SExpr): ProofNode {
  return isProofNode(x) ? x : { kind: "other", parts: [] };
}

async function readCounterexample(z3: Z3Low, problem: Problem, raw: string): Promise<Step[]> {
  let exprs: SExpr[];
  try {
    exprs = parseAll(raw);
  } catch {
    return [];
  }
  let proofExpr: SExpr | null = null;
  const find = (e: SExpr) => {
    if (proofExpr) return;
    if (head(e) === "proof" && e.kind === "list") proofExpr = e.items[1];
    else if (e.kind === "list") e.items.forEach(find);
  };
  exprs.forEach(find);
  if (!proofExpr) return [];

  const root = asNode(evalProof(proofExpr, new Map()));
  const steps: Step[] = [];
  const memo = new Map<ProofNode, number>();
  const byFact = new Map<string, number>();

  const isUserFact = (f: SExpr) => {
    const op = f.kind === "atom" ? f.text : head(f);
    return op !== null && problem.preds.has(op);
  };

  // Post-order: premises get lower step numbers than what they derive.
  const visit = (n: ProofNode): number[] => {
    if (memo.has(n)) return [memo.get(n)!];
    if (n.kind === "derive") {
      const premises = n.premises.flatMap(visit);
      const fact = n.fact;
      if (!isUserFact(fact)) {
        // Z3's query!N: the query clause's body, satisfied. It becomes the
        // final "false" step; pass its premises through.
        const idx = steps.push({ pred: null, args: [], premises, clause: null }) - 1;
        memo.set(n, idx);
        return [idx];
      }
      const key = print(fact);
      if (byFact.has(key)) {
        memo.set(n, byFact.get(key)!);
        return [byFact.get(key)!];
      }
      const idx =
        steps.push({
          pred: fact.kind === "atom" ? fact.text : head(fact)!,
          args: fact.kind === "list" ? fact.items.slice(1) : [],
          premises,
          clause: null,
        }) - 1;
      memo.set(n, idx);
      byFact.set(key, idx);
      return [idx];
    }
    if (n.kind === "mp") return n.parts.flatMap(visit);
    return [];
  };
  visit(root);

  // If the proof's last step is a user fact (query clause like Err ⇒ false,
  // or a head-constraint query without query!N), append the false step.
  if (steps.length > 0 && steps[steps.length - 1].pred !== null) {
    const last = steps.length - 1;
    steps.push({ pred: null, args: [], premises: [last], clause: null });
  }
  await attributeClauses(z3, problem, steps);
  return steps;
}

/**
 * For each step, finds the clause that derives it: same head predicate, same
 * body predicates in order, and a satisfiable constraint once the head and
 * body arguments are pinned to the step's ground values.
 */
async function attributeClauses(z3: Z3Low, problem: Problem, steps: Step[]) {
  const ctx = newContext(z3);
  try {
    const setup = await z3.eval_smtlib2_string(ctx, "(set-logic ALL)\n" + problem.declarationsOnly);
    if (z3Errors(setup).length > 0) return;
    for (const step of steps) {
      const premiseSteps = step.premises.map((p) => steps[p]);
      search: for (const clause of problem.clauses) {
        if (!clause) continue;
        if ((clause.head?.pred ?? null) !== step.pred) continue;
        if (clause.body.length !== premiseSteps.length) continue;
        // Spacer doesn't keep body order, so try each assignment of premises
        // to body atoms with the same predicate.
        for (const order of assignments(clause.body.map((b) => b.pred), premiseSteps.map((s) => s.pred ?? ""))) {
          const eqs: SExpr[] = [...clause.constraints];
          if (clause.head) clause.head.args.forEach((a, i) => eqs.push(list(atom("="), a, step.args[i])));
          clause.body.forEach((b, i) =>
            b.args.forEach((a, j) => eqs.push(list(atom("="), a, premiseSteps[order[i]].args[j]))),
          );
          const formula = list(atom("and"), atom("true"), ...eqs);
          const query =
            clause.vars.length > 0
              ? `(exists (${clause.vars.map((v) => `(${v.name} ${v.sort})`).join(" ")}) ${print(formula)})`
              : print(formula);
          const r = (
            await z3.eval_smtlib2_string(ctx, `(push 1)\n(assert ${query})\n(check-sat)\n(pop 1)`)
          ).trim();
          if (r === "sat") {
            step.clause = clause.index;
            break search;
          }
        }
      }
    }
  } finally {
    z3.del_context(ctx);
  }
}

/**
 * Every way to assign premises (by index) to body atoms so predicates match,
 * capped so a wide clause can't explode the search.
 */
function* assignments(body: string[], premises: string[], limit = 120): Generator<number[]> {
  const used = new Array<boolean>(premises.length).fill(false);
  const cur: number[] = [];
  let produced = 0;
  function* go(i: number): Generator<number[]> {
    if (produced >= limit) return;
    if (i === body.length) {
      produced++;
      yield [...cur];
      return;
    }
    for (let j = 0; j < premises.length; j++) {
      if (used[j] || premises[j] !== body[i]) continue;
      used[j] = true;
      cur.push(j);
      yield* go(i + 1);
      cur.pop();
      used[j] = false;
    }
  }
  yield* go(0);
}
