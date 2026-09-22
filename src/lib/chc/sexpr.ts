/**
 * S-expressions for SMT-LIB 2, with source offsets so the editor can point at
 * the exact clause a diagnostic or a counterexample step came from.
 */

export type Atom = { kind: "atom"; text: string; start: number; end: number };
export type List = { kind: "list"; items: SExpr[]; start: number; end: number };
export type SExpr = Atom | List;

export class ParseError extends Error {
  constructor(
    message: string,
    public start: number,
    public end: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export function atom(text: string): Atom {
  return { kind: "atom", text, start: -1, end: -1 };
}

export function list(...items: SExpr[]): List {
  return { kind: "list", items, start: -1, end: -1 };
}

export function isAtom(e: SExpr | undefined, text?: string): e is Atom {
  return !!e && e.kind === "atom" && (text === undefined || e.text === text);
}

/** The operator of a list, when it's a plain symbol. */
export function head(e: SExpr): string | null {
  return e.kind === "list" && e.items.length > 0 && e.items[0].kind === "atom"
    ? e.items[0].text
    : null;
}

/** Parses every top-level expression in `src`. */
export function parseAll(src: string): SExpr[] {
  const out: SExpr[] = [];
  const stack: { items: SExpr[]; start: number }[] = [];
  let i = 0;
  const n = src.length;

  const push = (e: SExpr) => {
    if (stack.length > 0) stack[stack.length - 1].items.push(e);
    else out.push(e);
  };

  while (i < n) {
    const c = src[i];
    if (c === ";") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      stack.push({ items: [], start: i });
      i++;
      continue;
    }
    if (c === ")") {
      const top = stack.pop();
      if (!top) throw new ParseError("unexpected )", i, i + 1);
      i++;
      push({ kind: "list", items: top.items, start: top.start, end: i });
      continue;
    }
    const start = i;
    if (c === "|") {
      i++;
      while (i < n && src[i] !== "|") i++;
      if (i >= n) throw new ParseError("unterminated |symbol|", start, n);
      i++;
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      if (i >= n) throw new ParseError("unterminated string", start, n);
      i++;
    } else {
      while (i < n && !/[\s();"|]/.test(src[i])) i++;
    }
    push({ kind: "atom", text: src.slice(start, i), start, end: i });
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    throw new ParseError("unclosed (", top.start, top.start + 1);
  }
  return out;
}

export function print(e: SExpr): string {
  if (e.kind === "atom") return e.text;
  return "(" + e.items.map(print).join(" ") + ")";
}

/** Capture-naive substitution of free symbols; respects binders it knows. */
export function substitute(e: SExpr, env: Map<string, SExpr>): SExpr {
  if (env.size === 0) return e;
  if (e.kind === "atom") return env.get(e.text) ?? e;
  const op = head(e);
  if ((op === "forall" || op === "exists") && e.items[1]?.kind === "list") {
    const inner = new Map(env);
    for (const b of e.items[1].items) {
      if (b.kind === "list" && b.items[0]?.kind === "atom") inner.delete(b.items[0].text);
    }
    return { ...e, items: [e.items[0], e.items[1], ...e.items.slice(2).map((x) => substitute(x, inner))] };
  }
  if (op === "let" && e.items[1]?.kind === "list") {
    const inner = new Map(env);
    const bindings = e.items[1].items.map((b) => {
      if (b.kind !== "list" || b.items.length !== 2) return b;
      if (b.items[0].kind === "atom") inner.delete(b.items[0].text);
      return { ...b, items: [b.items[0], substitute(b.items[1], env)] };
    });
    return {
      ...e,
      items: [e.items[0], { ...e.items[1], items: bindings }, ...e.items.slice(2).map((x) => substitute(x, inner))],
    };
  }
  if (op === "!") {
    return { ...e, items: [e.items[0], substitute(e.items[1], env), ...e.items.slice(2)] };
  }
  return { ...e, items: e.items.map((x) => substitute(x, env)) };
}

/** Inlines every `let` (sequentially-nested lets, as Z3 prints them). */
export function expandLets(e: SExpr): SExpr {
  if (e.kind === "atom") return e;
  const op = head(e);
  if (op === "let" && e.items[1]?.kind === "list" && e.items.length === 3) {
    const env = new Map<string, SExpr>();
    for (const b of e.items[1].items) {
      if (b.kind === "list" && b.items.length === 2 && b.items[0].kind === "atom") {
        env.set(b.items[0].text, expandLets(b.items[1]));
      }
    }
    return expandLets(substitute(e.items[2], env));
  }
  if (op === "!" && e.items.length >= 2) return expandLets(e.items[1]);
  return { ...e, items: e.items.map(expandLets) };
}
