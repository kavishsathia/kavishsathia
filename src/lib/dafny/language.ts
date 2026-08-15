/**
 * A Dafny mode for CodeMirror 6, written as a stream tokenizer — there's no
 * Lezer grammar for Dafny, and a hand-rolled tokenizer covers highlighting
 * well: keywords, specification clauses, types, strings, chars, numbers,
 * attributes, and Dafny's *nested* block comments.
 */

import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

/** Clauses that carry the specification — the heart of a Dafny program. */
const SPEC_KEYWORDS = new Set([
  "requires", "ensures", "invariant", "decreases", "modifies", "reads",
  "assert", "assume", "calc", "witness", "yield", "expect", "reveal",
]);

const KEYWORDS = new Set([
  "abstract", "allocated", "as", "break", "by", "case", "class", "codatatype",
  "const", "constructor", "continue", "datatype", "downto", "else", "exists",
  "export", "extends", "false", "for", "forall", "fresh", "function", "ghost",
  "greatest", "if", "import", "in", "include", "is", "iterator", "label",
  "least", "lemma", "match", "method", "module", "new", "newtype", "null",
  "old", "opaque", "opened", "predicate", "print", "provides", "refines",
  "return", "returns", "static", "then", "this", "to", "trait", "true",
  "twostate", "type", "unchanged", "var", "while", "yields",
]);

const TYPES = new Set([
  "array", "array2", "array3", "bool", "bv8", "bv16", "bv32", "bv64", "char",
  "imap", "int", "iset", "map", "multiset", "nat", "object", "ORDINAL",
  "real", "seq", "set", "string",
]);

type State = {
  commentDepth: number;
};

const dafnyStream = StreamLanguage.define<State>({
  name: "dafny",

  startState() {
    return { commentDepth: 0 };
  },

  token(stream, state) {
    if (state.commentDepth > 0) {
      while (!stream.eol()) {
        if (stream.match("/*")) {
          state.commentDepth++;
        } else if (stream.match("*/")) {
          state.commentDepth--;
          if (state.commentDepth === 0) return "comment";
        } else {
          stream.next();
        }
      }
      return "comment";
    }

    if (stream.eatSpace()) return null;

    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.commentDepth = 1;
      return "comment";
    }

    // Attributes: {:opaque}, {:induction false}, ...
    if (stream.match(/^\{:[^}]*\}?/)) return "meta";

    // Verbatim and ordinary strings.
    if (stream.match(/^@"(?:[^"]|"")*"?/)) return "string";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)'/)) return "string";

    if (stream.match(/^0x[0-9a-fA-F_]+/) || stream.match(/^\d[\d_]*(\.\d[\d_]*)?/)) {
      return "number";
    }

    if (stream.match(/^[a-zA-Z_'?][a-zA-Z0-9_'?]*/)) {
      const word = stream.current();
      if (SPEC_KEYWORDS.has(word)) return "modifier";
      if (KEYWORDS.has(word)) return "keyword";
      if (TYPES.has(word)) return "typeName";
      return null;
    }

    // Multi-character operators worth recognising as one unit.
    if (
      stream.match("<==>") || stream.match("==>") || stream.match("<==") ||
      stream.match("::") || stream.match(":=") || stream.match("!=") ||
      stream.match("==") || stream.match("<=") || stream.match(">=") ||
      stream.match("&&") || stream.match("||")
    ) {
      return "operator";
    }

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
  },
});

/**
 * Grayscale highlighting in the site's palette: specification clauses and
 * keywords carry weight, prose-like parts (comments, literals) recede.
 */
const dafnyHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#1a1a1a", fontWeight: "600" },
  { tag: t.modifier, color: "#1a1a1a", fontWeight: "600", textDecoration: "underline", textDecorationColor: "#c9c9c2", textUnderlineOffset: "3px" },
  { tag: t.typeName, color: "#2d2d2d", fontWeight: "500" },
  { tag: t.comment, color: "#9a9a94", fontStyle: "italic" },
  { tag: t.string, color: "#55554f" },
  { tag: t.number, color: "#55554f" },
  { tag: t.meta, color: "#9a9a94" },
  { tag: t.operator, color: "#2d2d2d" },
]);

export function dafnyLanguage(): Extension {
  return [dafnyStream, syntaxHighlighting(dafnyHighlightStyle)];
}
