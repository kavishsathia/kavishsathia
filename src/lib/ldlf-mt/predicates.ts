/**
 * Predicate atoms for LDLf modulo theories.
 *
 * A predicate is a single linear integer comparison written in braces inside
 * the formula — `{x > 10}`, `{2*x + y <= 7}` — and combined with the usual
 * LDLf boolean connectives outside the braces: `{x > 10} & !{y = 0}`.
 *
 * Each comparison is normalised to `sum ⋈ 0` so that syntactic variants
 * (`x > 5`, `5 < x`, `x - 5 > 0`) collapse into one atom, which matters:
 * every distinct atom doubles the alphabet.
 */

export class PredicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PredicateError";
  }
}

/** A linear expression: sum of coeff·var plus a constant. */
export type LinExpr = {
  coeffs: Map<string, number>;
  constant: number;
};

type CanonicalOp = "<" | "<=" | "=" | "!=";
type SourceOp = "<" | "<=" | ">" | ">=" | "=" | "!=";

export type Predicate = {
  /** Canonical form: `expr op 0`. `>` and `>=` are normalised away. */
  expr: LinExpr;
  op: CanonicalOp;
  /** Dedup key: two predicates with the same key are the same atom. */
  key: string;
  /** The comparison as the user wrote it, lightly normalised for display. */
  display: string;
  /** The negation, shown by flipping the comparison operator. */
  negatedDisplay: string;
  /** Variables the predicate mentions. */
  variables: string[];
};

const OP_DISPLAY: Record<SourceOp, string> = {
  "<": "<",
  "<=": "≤",
  ">": ">",
  ">=": "≥",
  "=": "=",
  "!=": "≠",
};

const OP_NEGATED: Record<SourceOp, SourceOp> = {
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
  "=": "!=",
  "!=": "=",
};

// ---------------------------------------------------------------------------
// Tokenizer + recursive descent for one comparison
// ---------------------------------------------------------------------------

type Token =
  | { kind: "int"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: SourceOp }
  | { kind: "punct"; ch: "+" | "-" | "*" | "(" | ")" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      tokens.push({ kind: "int", value: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: "ident", name: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "!=") {
      tokens.push({ kind: "op", op: two });
      i += 2;
      continue;
    }
    if (two === "==") {
      tokens.push({ kind: "op", op: "=" });
      i += 2;
      continue;
    }
    if (ch === "<" || ch === ">" || ch === "=") {
      tokens.push({ kind: "op", op: ch });
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "(" || ch === ")") {
      tokens.push({ kind: "punct", ch });
      i++;
      continue;
    }
    throw new PredicateError(`Unexpected character '${ch}' in {${src.trim()}}.`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private src: string,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private fail(what: string): never {
    throw new PredicateError(`${what} in {${this.src.trim()}}.`);
  }

  parseComparison(): { lhs: LinExpr; op: SourceOp; rhs: LinExpr } {
    const lhs = this.parseSum();
    const t = this.peek();
    if (!t || t.kind !== "op") this.fail("Expected a comparison operator");
    this.pos++;
    const rhs = this.parseSum();
    if (this.pos !== this.tokens.length) this.fail("Trailing input after the comparison");
    return { lhs, op: t.op, rhs };
  }

  private parseSum(): LinExpr {
    let acc = this.parseTerm(1);
    for (;;) {
      const t = this.peek();
      if (t?.kind === "punct" && (t.ch === "+" || t.ch === "-")) {
        this.pos++;
        acc = addExpr(acc, this.parseTerm(t.ch === "-" ? -1 : 1));
      } else {
        return acc;
      }
    }
  }

  private parseTerm(sign: number): LinExpr {
    // leading unary minus (possibly repeated)
    let t = this.peek();
    while (t?.kind === "punct" && t.ch === "-") {
      sign = -sign;
      this.pos++;
      t = this.peek();
    }

    let acc = this.parseFactor();
    for (;;) {
      const next = this.peek();
      if (next?.kind === "punct" && next.ch === "*") {
        this.pos++;
        acc = mulExpr(acc, this.parseFactor(), this.src);
      } else {
        break;
      }
    }
    return scaleExpr(acc, sign);
  }

  private parseFactor(): LinExpr {
    const t = this.peek();
    if (!t) this.fail("Expected a number or variable");
    if (t.kind === "int") {
      this.pos++;
      return { coeffs: new Map(), constant: t.value };
    }
    if (t.kind === "ident") {
      this.pos++;
      return { coeffs: new Map([[t.name, 1]]), constant: 0 };
    }
    if (t.kind === "punct" && t.ch === "(") {
      this.pos++;
      const inner = this.parseSum();
      const close = this.peek();
      if (!(close?.kind === "punct" && close.ch === ")")) this.fail("Expected ')'");
      this.pos++;
      return inner;
    }
    if (t.kind === "punct" && t.ch === "-") {
      this.pos++;
      return scaleExpr(this.parseFactor(), -1);
    }
    this.fail("Expected a number or variable");
  }
}

function addExpr(a: LinExpr, b: LinExpr): LinExpr {
  const coeffs = new Map(a.coeffs);
  for (const [v, c] of b.coeffs) {
    const sum = (coeffs.get(v) ?? 0) + c;
    if (sum === 0) coeffs.delete(v);
    else coeffs.set(v, sum);
  }
  return { coeffs, constant: a.constant + b.constant };
}

function scaleExpr(e: LinExpr, k: number): LinExpr {
  if (k === 1) return e;
  const coeffs = new Map<string, number>();
  for (const [v, c] of e.coeffs) if (c * k !== 0) coeffs.set(v, c * k);
  return { coeffs, constant: e.constant * k };
}

function mulExpr(a: LinExpr, b: LinExpr, src: string): LinExpr {
  const aConst = a.coeffs.size === 0;
  const bConst = b.coeffs.size === 0;
  if (!aConst && !bConst) {
    throw new PredicateError(
      `Only linear arithmetic is supported — can't multiply two variables in {${src.trim()}}.`,
    );
  }
  return aConst ? scaleExpr(b, a.constant) : scaleExpr(a, b.constant);
}

// ---------------------------------------------------------------------------
// Canonicalisation + display
// ---------------------------------------------------------------------------

function canonicalize(lhs: LinExpr, op: SourceOp, rhs: LinExpr): { expr: LinExpr; op: CanonicalOp } {
  // Move everything to the left: diff ⋈ 0.
  let expr = addExpr(lhs, scaleExpr(rhs, -1));
  let cOp: CanonicalOp;
  switch (op) {
    case "<":
      cOp = "<";
      break;
    case "<=":
      cOp = "<=";
      break;
    case ">":
      expr = scaleExpr(expr, -1);
      cOp = "<";
      break;
    case ">=":
      expr = scaleExpr(expr, -1);
      cOp = "<=";
      break;
    case "=":
    case "!=": {
      // Sign-normalise so `x = 5` and `5 = x` share a key.
      const firstVar = [...expr.coeffs.keys()].sort()[0];
      const lead = firstVar !== undefined ? expr.coeffs.get(firstVar)! : expr.constant;
      if (lead < 0) expr = scaleExpr(expr, -1);
      cOp = op;
      break;
    }
  }
  return { expr, op: cOp };
}

function keyOf(expr: LinExpr, op: CanonicalOp): string {
  const vars = [...expr.coeffs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return `${vars.map(([v, c]) => `${c}${v}`).join("+")}|${expr.constant}|${op}`;
}

function renderSide(e: LinExpr): string {
  const parts: string[] = [];
  const vars = [...e.coeffs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [v, c] of vars) {
    const term = Math.abs(c) === 1 ? v : `${Math.abs(c)}${v}`;
    if (parts.length === 0) parts.push(c < 0 ? `-${term}` : term);
    else parts.push(`${c < 0 ? "-" : "+"} ${term}`);
  }
  if (e.constant !== 0 || parts.length === 0) {
    const k = Math.abs(e.constant);
    if (parts.length === 0) parts.push(`${e.constant}`);
    else parts.push(`${e.constant < 0 ? "-" : "+"} ${k}`);
  }
  return parts.join(" ");
}

function renderComparison(lhs: LinExpr, op: SourceOp, rhs: LinExpr): string {
  return `${renderSide(lhs)} ${OP_DISPLAY[op]} ${renderSide(rhs)}`;
}

/** Parses one `{...}` body into a predicate. */
export function parsePredicate(src: string): Predicate {
  const trimmed = src.trim();
  if (trimmed === "") throw new PredicateError("Empty predicate {}.");
  const { lhs, op, rhs } = new Parser(tokenize(src), src).parseComparison();
  const canonical = canonicalize(lhs, op, rhs);
  return {
    expr: canonical.expr,
    op: canonical.op,
    key: keyOf(canonical.expr, canonical.op),
    display: renderComparison(lhs, op, rhs),
    negatedDisplay: renderComparison(lhs, OP_NEGATED[op], rhs),
    variables: [...canonical.expr.coeffs.keys()].sort(),
  };
}

/** Evaluates the canonical comparison under a concrete assignment. */
export function evaluatePredicate(
  pred: Predicate,
  assignment: Record<string, number>,
): boolean {
  let value = pred.expr.constant;
  for (const [v, c] of pred.expr.coeffs) {
    const x = assignment[v];
    if (x === undefined) throw new PredicateError(`No value for variable '${v}'.`);
    value += c * x;
  }
  switch (pred.op) {
    case "<":
      return value < 0;
    case "<=":
      return value <= 0;
    case "=":
      return value === 0;
    case "!=":
      return value !== 0;
  }
}

// ---------------------------------------------------------------------------
// Extraction from a formula
// ---------------------------------------------------------------------------

/** Identifiers that may appear in the letter-level formula besides our letters. */
const RESERVED = new Set(["tt", "ff", "end", "last", "true", "false"]);

export type Extraction = {
  /** The formula with each `{...}` replaced by a propositional letter. */
  formula: string;
  /** Distinct predicates, in order of first appearance; index i uses letters[i]. */
  predicates: Predicate[];
  /** letters[i] is the proposition standing in for predicates[i]. */
  letters: string[];
};

export const MAX_PREDICATES = 8;

/**
 * Replaces every `{comparison}` in an LDLf formula with a fresh propositional
 * letter, deduplicating syntactic variants of the same atom. Bare
 * propositions are rejected — in this tool every atom must be a predicate.
 */
export function extractPredicates(input: string): Extraction {
  const predicates: Predicate[] = [];
  const letters: string[] = [];
  const byKey = new Map<string, number>();

  let formula = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "}") throw new PredicateError("Unmatched '}' in the formula.");
    if (ch !== "{") {
      formula += ch;
      i++;
      continue;
    }
    const close = input.indexOf("}", i + 1);
    if (close === -1) throw new PredicateError("Unclosed '{' in the formula.");
    const body = input.slice(i + 1, close);
    const pred = parsePredicate(body);

    let index = byKey.get(pred.key);
    if (index === undefined) {
      index = predicates.length;
      if (index >= MAX_PREDICATES) {
        throw new PredicateError(
          `Too many distinct predicates — each one doubles the alphabet, so the limit is ${MAX_PREDICATES}.`,
        );
      }
      byKey.set(pred.key, index);
      predicates.push(pred);
      letters.push(`p${index}`);
    }
    formula += letters[index];
    i = close + 1;
  }

  // Everything that still looks like an identifier must be a keyword or one
  // of our letters — a bare proposition means the user forgot the braces.
  const letterSet = new Set(letters);
  for (const m of formula.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
    const word = m[0];
    if (!RESERVED.has(word) && !letterSet.has(word)) {
      throw new PredicateError(
        `Bare proposition '${word}' — every atom here is a predicate, write it like {${word} > 0}.`,
      );
    }
  }

  return { formula, predicates, letters };
}
