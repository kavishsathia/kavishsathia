/**
 * A TLA+ mode for CodeMirror 6 that also understands PlusCal. A PlusCal
 * algorithm lives inside a TLA+ block comment — `(* --algorithm Name ... *)`
 * — so that comment is tokenized as code, with PlusCal's own keywords,
 * while ordinary `(* ... *)` comments (which nest in TLA+) and `\*` line
 * comments stay comments.
 */

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

const TLA_KEYWORDS = new Set([
  "ACTION", "ASSUME", "ASSUMPTION", "AXIOM", "BY", "CASE", "CHOOSE", "CONSTANT", "CONSTANTS",
  "COROLLARY", "DEF", "DEFINE", "DEFS", "DOMAIN", "ELSE", "ENABLED", "EXCEPT", "EXTENDS", "HAVE",
  "HIDE", "IF", "IN", "INSTANCE", "LAMBDA", "LEMMA", "LET", "LOCAL", "MODULE", "NEW", "OBVIOUS",
  "OMITTED", "ONLY", "OTHER", "PICK", "PROOF", "PROPOSITION", "PROVE", "QED", "RECURSIVE", "SF_",
  "STATE", "SUBSET", "SUFFICES", "TAKE", "TEMPORAL", "THEN", "THEOREM", "UNCHANGED", "UNION",
  "USE", "VARIABLE", "VARIABLES", "WF_", "WITH", "WITNESS",
]);

const TLA_CONSTANTS = new Set(["TRUE", "FALSE", "BOOLEAN", "STRING", "Nat", "Int", "Real", "Infinity"]);

const PCAL_KEYWORDS = new Set([
  "algorithm", "assert", "await", "begin", "call", "define", "do", "either", "else", "elsif",
  "end", "fair", "goto", "if", "macro", "or", "print", "procedure", "process", "return", "skip",
  "then", "variable", "variables", "when", "while", "with",
]);

type State = {
  /** Depth of ordinary (* *) comments; they nest. */
  comment: number;
  /** Inside the (* --algorithm ... *) block. */
  pcal: boolean;
};

const tla = StreamLanguage.define<State>({
  name: "tla",

  startState: () => ({ comment: 0, pcal: false }),
  copyState: (s) => ({ ...s }),

  token(stream, state) {
    if (state.comment > 0) {
      while (!stream.eol()) {
        if (stream.match("(*")) state.comment++;
        else if (stream.match("*)")) {
          state.comment--;
          if (state.comment === 0) return "comment";
        } else stream.next();
      }
      return "comment";
    }

    if (stream.eatSpace()) return null;

    if (stream.match("\\*")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.match(/^\(\*\s*--(?:fair\s+)?algorithm\b/)) {
      state.pcal = true;
      return "meta";
    }
    if (state.pcal && stream.match("*)")) {
      state.pcal = false;
      return "meta";
    }
    if (stream.match("(*")) {
      state.comment = 1;
      return "comment";
    }

    // Module delimiters: ---- MODULE M ----  and  ====
    if (stream.sol() && stream.match(/^-{4,}/)) return "meta";
    if (stream.match(/^={4,}/)) return "meta";

    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\d+(\.\d+)?/)) return "number";

    // \A \E \in \notin \union \cup \subseteq \X ... and \/ /\
    if (stream.match(/^\\[A-Za-z]+/)) return "operator";
    if (stream.match("/\\") || stream.match("\\/")) return "operator";

    if (stream.match(/^(WF|SF)_/)) return "keyword";
    if (stream.match(/^[A-Za-z_][\w]*/)) {
      const w = stream.current();
      if (TLA_KEYWORDS.has(w)) return "keyword";
      if (TLA_CONSTANTS.has(w)) return "atom";
      if (state.pcal && PCAL_KEYWORDS.has(w)) return "controlKeyword";
      if (state.pcal && w === "self") return "atom";
      return "variableName";
    }

    if (
      stream.match("<=>") || stream.match("=>") || stream.match("==") || stream.match(":=") ||
      stream.match("|->") || stream.match("->") || stream.match("<-") || stream.match("~>") ||
      stream.match("[]") || stream.match("<>") || stream.match("<<") || stream.match(">>") ||
      stream.match("..") || stream.match("@@") || stream.match(":>") || stream.match("/=") ||
      stream.match("#") || stream.match("'")
    ) {
      return "operator";
    }

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "\\*", block: { open: "(*", close: "*)" } },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
  },
});

/** Grayscale, in the site's palette (as the Dafny tool's). */
const style = HighlightStyle.define([
  { tag: t.keyword, color: "#1a1a1a", fontWeight: "600" },
  { tag: t.controlKeyword, color: "#1a1a1a", fontWeight: "600" },
  { tag: t.atom, color: "#2d2d2d", fontWeight: "500" },
  { tag: t.comment, color: "#9a9a94", fontStyle: "italic" },
  { tag: t.meta, color: "#9a9a94" },
  { tag: t.string, color: "#55554f" },
  { tag: t.number, color: "#55554f" },
  { tag: t.operator, color: "#2d2d2d" },
]);

export function tlaLanguage(): Extension {
  return [tla, syntaxHighlighting(style)];
}
