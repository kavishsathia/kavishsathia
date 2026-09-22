/**
 * SMT-LIB 2 highlighting for CodeMirror 6, tuned for CHC problems: commands
 * and binders carry weight, `false` (the head of a query) is marked, and
 * comments recede. Same grayscale palette as the Dafny mode.
 */

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

const COMMANDS = new Set([
  "set-logic", "set-option", "set-info", "declare-fun", "declare-const",
  "declare-sort", "declare-datatypes", "declare-datatype", "define-fun",
  "define-sort", "assert", "check-sat", "get-model", "get-proof", "get-info",
  "exit", "push", "pop",
]);

const BINDERS = new Set(["forall", "exists", "let", "=>", "!"]);

const SORTS = new Set(["Int", "Bool", "Real", "Array", "BitVec"]);

const smtStream = StreamLanguage.define<Record<string, never>>({
  name: "smtlib",
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(";")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"]|"")*"?/)) return "string";
    if (stream.match(/^\|[^|]*\|?/)) return "variableName";
    if (stream.match(/^:[^\s()]+/)) return "meta";
    if (stream.match(/^(#x[0-9a-fA-F]+|#b[01]+|\d+(\.\d+)?)/)) return "number";
    if (stream.match(/^[^\s();"|]+/)) {
      const word = stream.current();
      if (COMMANDS.has(word)) return "keyword";
      if (BINDERS.has(word)) return "modifier";
      if (SORTS.has(word)) return "typeName";
      if (word === "false" || word === "true") return "bool";
      return null;
    }
    stream.next();
    return "bracket";
  },
  languageData: {
    commentTokens: { line: ";" },
    closeBrackets: { brackets: ["(", '"', "|"] },
  },
});

const smtHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#1a1a1a", fontWeight: "600" },
  { tag: t.modifier, color: "#1a1a1a", fontWeight: "500" },
  { tag: t.typeName, color: "#2d2d2d", fontWeight: "500" },
  { tag: t.bool, color: "#1a1a1a", fontWeight: "600", textDecoration: "underline", textDecorationColor: "#c9c9c2", textUnderlineOffset: "3px" },
  { tag: t.comment, color: "#9a9a94", fontStyle: "italic" },
  { tag: t.string, color: "#55554f" },
  { tag: t.number, color: "#55554f" },
  { tag: t.meta, color: "#9a9a94" },
  { tag: t.bracket, color: "#b5b5ae" },
]);

export function smtLanguage(): Extension {
  return [smtStream, syntaxHighlighting(smtHighlightStyle)];
}

// ── Math notation ────────────────────────────────────────────────────────

type MathState = { inComment: boolean };

const mathStream = StreamLanguage.define<MathState>({
  name: "chc-math",
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inComment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inComment = true;
      return "comment";
    }
    if (stream.match(/^\d+(\.\d+)?/)) return "number";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_']*/)) {
      const w = stream.current();
      if (w === "pred" || w === "predicate") return "keyword";
      if (w === "if" || w === "then" || w === "else" || w === "and" || w === "or" || w === "not") return "modifier";
      if (w === "int" || w === "real" || w === "bool") return "typeName";
      if (w === "true" || w === "false") return "bool";
      // Calls are predicate applications: the only functions there are.
      if (stream.match(/^\(/, false)) return "function";
      return null;
    }
    if (stream.match(/^(<==>|==>|=>|->|⇒|⇔|→)/)) return "modifier";
    if (stream.match(/^(&&|\|\||[∧∨¬!])/)) return "operator";
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["("] },
  },
});

const mathHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#1a1a1a", fontWeight: "600" },
  { tag: t.modifier, color: "#1a1a1a", fontWeight: "600" },
  { tag: t.typeName, color: "#2d2d2d", fontWeight: "500" },
  { tag: t.function(t.variableName), color: "#1a1a1a", fontWeight: "500" },
  { tag: t.bool, color: "#1a1a1a", fontWeight: "600", textDecoration: "underline", textDecorationColor: "#c9c9c2", textUnderlineOffset: "3px" },
  { tag: t.comment, color: "#9a9a94", fontStyle: "italic" },
  { tag: t.number, color: "#55554f" },
  { tag: t.operator, color: "#2d2d2d" },
]);

export function mathLanguage(): Extension {
  return [mathStream, syntaxHighlighting(mathHighlightStyle)];
}
