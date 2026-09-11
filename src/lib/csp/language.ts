/**
 * A CSP# mode for CodeMirror 6 as a stream tokenizer: keywords, directives,
 * process operators, comments, numbers, strings.
 */

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

const KEYWORDS = new Set([
  "var", "hvar", "channel", "enum", "if", "else", "ifa", "ifb", "while", "case",
  "default", "atomic", "assert", "call", "new", "interrupt", "xor",
]);

/** Process constants and the invisible event carry the most weight. */
const PROCESS_WORDS = new Set(["Skip", "Stop", "tau"]);

const LITERALS = new Set(["true", "false"]);

type State = { inBlockComment: boolean };

const cspStream = StreamLanguage.define<State>({
  name: "csp#",

  startState() {
    return { inBlockComment: false };
  },

  token(stream, state) {
    if (state.inBlockComment) {
      while (!stream.eol()) {
        if (stream.match("*/")) {
          state.inBlockComment = false;
          return "comment";
        }
        stream.next();
      }
      return "comment";
    }

    if (stream.eatSpace()) return null;

    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }

    // Directives: #define, #assert, #alphabet, #import, #include
    if (stream.match(/^#\s*[a-zA-Z]+/)) return "meta";

    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\d+/)) return "number";

    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
      const word = stream.current();
      if (PROCESS_WORDS.has(word)) return "modifier";
      if (KEYWORDS.has(word)) return "keyword";
      if (LITERALS.has(word)) return "atom";
      return null;
    }

    // Process operators, longest first.
    if (
      stream.match("|||") || stream.match("[*]") || stream.match("||") ||
      stream.match("[]") || stream.match("<>") || stream.match("->") ||
      stream.match("\\") || stream.match("@")
    ) {
      return "operator";
    }
    if (
      stream.match("==") || stream.match("!=") || stream.match("<=") ||
      stream.match(">=") || stream.match("&&") || stream.match("++") ||
      stream.match("--")
    ) {
      return null;
    }

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
  },
});

const cspHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#1a1a1a", fontWeight: "600" },
  { tag: t.modifier, color: "#1a1a1a", fontWeight: "600", textDecoration: "underline", textDecorationColor: "#c9c9c2", textUnderlineOffset: "3px" },
  { tag: t.atom, color: "#55554f" },
  { tag: t.comment, color: "#9a9a94", fontStyle: "italic" },
  { tag: t.string, color: "#55554f" },
  { tag: t.number, color: "#55554f" },
  { tag: t.meta, color: "#9a9a94" },
  { tag: t.operator, color: "#1a1a1a", fontWeight: "600" },
]);

export function cspLanguage(): Extension {
  return [cspStream, syntaxHighlighting(cspHighlightStyle)];
}
