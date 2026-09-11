import { CspError, type Loc } from "./ast";

export type TokKind = "id" | "int" | "string" | "op" | "eof";

export type Token = { kind: TokKind; text: string; loc: Loc };

/**
 * Multi-character operators, longest first so the greedy match is right.
 * `[]`, `[*]` and `<>` are single tokens because the process grammar treats
 * them as operators distinct from `[`, `]`, `<`, `>`.
 */
const OPERATORS = [
  "|||", "[*]", "<->", "/\\", "\\/",
  "||", "[]", "<>", "->", "==", "!=", "<=", ">=", "&&", "++", "--", "..", "|=",
  "#", ";", ",", ".", "(", ")", "{", "}", "[", "]", "!", "?", "=", "<", ">",
  "\\", "@", ":", "+", "-", "*", "/", "%", "&", "|", "^", "$",
];

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  const loc = (start: number, end: number): Loc => ({
    pos: start,
    end,
    line,
    col: start - lineStart + 1,
  });

  while (i < n) {
    const c = src[i];

    if (c === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }

    // Comments.
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= n) throw new CspError("unterminated block comment", loc(start, n));
      i += 2;
      continue;
    }

    // Identifiers and keywords.
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
      toks.push({ kind: "id", text: src.slice(start, i), loc: loc(start, i) });
      continue;
    }

    // Integers.
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < n && /[0-9]/.test(src[i])) i++;
      toks.push({ kind: "int", text: src.slice(start, i), loc: loc(start, i) });
      continue;
    }

    // Strings.
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && src[i] !== '"' && src[i] !== "\n") i++;
      if (src[i] !== '"') throw new CspError("unterminated string", loc(start, i));
      i++;
      toks.push({ kind: "string", text: src.slice(start + 1, i - 1), loc: loc(start, i) });
      continue;
    }

    let matched = false;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        toks.push({ kind: "op", text: op, loc: loc(i, i + op.length) });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new CspError(`unexpected character '${c}'`, loc(i, i + 1));
    }
  }

  toks.push({ kind: "eof", text: "<eof>", loc: loc(n, n) });
  return toks;
}
