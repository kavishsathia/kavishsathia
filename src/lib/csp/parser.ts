/**
 * A recursive-descent parser for CSP#, transcribed from the ANTLR grammar in
 * the PAT 3.5 user manual (3.1.1.5 "Grammar Rules"). The process-operator
 * precedence is exactly the grammar's chain:
 *
 *   interleaveExpr   |||
 *   parallelExpr     ||
 *   generalChoice    []
 *   internalChoice   <>
 *   externalChoice   [*]
 *   interruptExpr    interrupt
 *   hidingExpr       \ {…}
 *   sequentialExpr   ;
 *   guardExpr        [cond] P
 *   channelExpr      c!e -> P, c?x -> P
 *   eventExpr        e{…} -> P, {…} -> P, (a, b) -> P
 *   caseExpr / ifExpr / atomicExpr / atom
 */

import {
  CspError,
  type Block,
  type ChanDecl,
  type Define,
  type Ev,
  type EventListItem,
  type EventName,
  type Expr,
  type Loc,
  type Proc,
  type ProcDef,
  type Range,
  type RecordElem,
  type Spec,
  type Stmt,
  type VarDecl,
  type VarRange,
} from "./ast";
import { tokenize, type Token } from "./lexer";

const KEYWORDS = new Set([
  "Skip", "Stop", "if", "else", "ifa", "ifb", "case", "default", "atomic",
  "assert", "call", "new", "tau", "interrupt", "true", "false", "xor", "var",
  "hvar", "channel", "enum", "while",
]);

class Parser {
  private toks: Token[];
  private i = 0;
  private nextId = 1;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  // -- token helpers --------------------------------------------------------

  peek(off = 0): Token {
    return this.toks[Math.min(this.i + off, this.toks.length - 1)];
  }
  private at(text: string, off = 0): boolean {
    const t = this.peek(off);
    return (t.kind === "op" || t.kind === "id") && t.text === text;
  }
  private atId(off = 0): boolean {
    const t = this.peek(off);
    return t.kind === "id" && !KEYWORDS.has(t.text);
  }
  private advance(): Token {
    return this.toks[this.i++];
  }
  private accept(text: string): Token | null {
    if (this.at(text)) return this.advance();
    return null;
  }
  private expect(text: string, what?: string): Token {
    if (this.at(text)) return this.advance();
    const t = this.peek();
    throw new CspError(
      `expected '${text}'${what ? ` ${what}` : ""} but found '${t.text}'`,
      t.loc,
    );
  }
  private expectId(what = "identifier"): Token {
    const t = this.peek();
    if (!this.atId()) throw new CspError(`expected ${what} but found '${t.text}'`, t.loc);
    return this.advance();
  }
  private fail(msg: string): never {
    throw new CspError(msg, this.peek().loc);
  }
  private span(from: Loc): Loc {
    const last = this.toks[Math.max(0, this.i - 1)].loc;
    return { pos: from.pos, end: Math.max(from.end, last.end), line: from.line, col: from.col };
  }
  private id(): number {
    return this.nextId++;
  }

  // -- specification --------------------------------------------------------

  parseSpec(): Spec {
    const spec: Spec = {
      defines: new Map(),
      vars: [],
      channels: [],
      procs: new Map(),
      alphabets: new Map(),
      asserts: [],
    };

    while (this.peek().kind !== "eof") {
      if (this.at("#")) {
        this.parseDirective(spec);
      } else if (this.at("var") || this.at("hvar")) {
        spec.vars.push(this.parseVarDecl());
      } else if (this.at("channel")) {
        spec.channels.push(this.parseChannel());
      } else if (this.at("enum")) {
        this.parseEnum(spec);
      } else if (this.atId()) {
        const def = this.parseProcDef();
        if (spec.procs.has(def.name)) {
          throw new CspError(`process '${def.name}' is defined twice`, def.loc);
        }
        spec.procs.set(def.name, def);
      } else if (this.at(";")) {
        this.advance();
      } else {
        this.fail(`unexpected '${this.peek().text}' at top level`);
      }
    }
    return spec;
  }

  private parseDirective(spec: Spec) {
    const hash = this.expect("#");
    const kw = this.advance();
    switch (kw.text) {
      case "import":
      case "include": {
        const s = this.advance();
        throw new CspError(
          `#${kw.text} "${s.text}" is not supported in the browser verifier`,
          this.span(hash.loc),
        );
      }
      case "define": {
        const name = this.expectId("macro name");
        let params: string[] | undefined;
        // dparameter: '(' ID (',' ID)* ')' — only if it is exactly that and
        // something follows before ';' (otherwise `#define g (x);` is a value).
        if (this.at("(") && this.looksLikeParamList()) {
          this.advance();
          params = [this.expectId("parameter").text];
          while (this.accept(",")) params.push(this.expectId("parameter").text);
          this.expect(")");
        }
        let body: Define["body"];
        if (this.at("{")) {
          body = { k: "block", b: this.parseBlock() };
        } else {
          body = { k: "expr", e: this.parseExpression() };
        }
        this.expect(";", "after #define");
        spec.defines.set(name.text, { name: name.text, params, body, loc: this.span(hash.loc) });
        return;
      }
      case "alphabet": {
        const name = this.expectId("process name");
        this.expect("{");
        const items: EventListItem[] = [this.parseEventListItem()];
        while (this.accept(",")) items.push(this.parseEventListItem());
        this.expect("}");
        this.expect(";");
        spec.alphabets.set(name.text, items);
        return;
      }
      case "assert": {
        const name = this.expectId("process name");
        const args: Expr[] = [];
        if (this.accept("(")) {
          if (!this.at(")")) {
            args.push(this.parseArgument());
            while (this.accept(",")) args.push(this.parseArgument());
          }
          this.expect(")");
        }
        // The rest of the assertion (LTL, refinement, ...) is not needed by a
        // trace checker; keep its text for display.
        const start = this.peek().loc.pos;
        let end = start;
        while (!this.at(";") && this.peek().kind !== "eof") end = this.advance().loc.end;
        this.expect(";");
        spec.asserts.push({
          proc: { name: name.text, args },
          text: this.sourceBetween(start, end),
          loc: this.span(hash.loc),
        });
        return;
      }
      default:
        throw new CspError(`unknown directive '#${kw.text}'`, kw.loc);
    }
  }

  private sourceBetween(a: number, b: number): string {
    // Reconstruct from tokens (the parser does not keep the source string).
    const parts: string[] = [];
    for (const t of this.toks) {
      if (t.loc.pos >= a && t.loc.end <= b) parts.push(t.kind === "string" ? `"${t.text}"` : t.text);
    }
    return parts.join(" ");
  }

  private looksLikeParamList(): boolean {
    // at '('
    let k = 1;
    if (!this.atId(k)) return false;
    k++;
    while (this.at(",", k)) {
      k++;
      if (!this.atId(k)) return false;
      k++;
    }
    if (!this.at(")", k)) return false;
    return !this.at(";", k + 1);
  }

  private parseEnum(spec: Spec) {
    const kw = this.expect("enum");
    this.expect("{");
    let v = 0;
    do {
      const name = this.expectId("enum member");
      spec.defines.set(name.text, {
        name: name.text,
        body: { k: "expr", e: { k: "int", v: v++, loc: name.loc } },
        loc: name.loc,
      });
    } while (this.accept(","));
    this.expect("}");
    this.expect(";");
    void kw;
  }

  private parseVarDecl(): VarDecl {
    const kw = this.advance(); // var | hvar
    if (this.at("<")) {
      this.fail("user-defined types (var<Type>) are not supported");
    }
    const name = this.expectId("variable name");
    let dims: Expr[] | undefined;
    while (this.at("[")) {
      this.advance();
      (dims ??= []).push(this.parseExpression());
      this.expect("]");
    }
    let range: VarRange | undefined;
    if (this.at(":")) range = this.parseVarRange();
    let init: Expr | undefined;
    if (this.accept("=")) {
      if (this.at("*")) this.fail("nondeterministic initial values (= *) are not supported");
      init = this.at("[") ? this.parseRecord() : this.parseExpression();
    }
    this.expect(";", "after variable declaration");
    return { name: name.text, hidden: kw.text === "hvar", dims, init, range, loc: this.span(kw.loc) };
  }

  private parseVarRange(): VarRange {
    this.expect(":");
    this.expect("{");
    let lo: Expr | undefined;
    let hi: Expr | undefined;
    if (!this.at("..")) lo = this.parseAdditive();
    this.expect("..");
    if (!this.at("}")) hi = this.parseAdditive();
    this.expect("}");
    return { lo, hi };
  }

  private parseChannel(): ChanDecl {
    const kw = this.expect("channel");
    const name = this.expectId("channel name");
    let count: Expr | undefined;
    if (this.accept("[")) {
      count = this.parseAdditive();
      this.expect("]");
    }
    const size = this.parseAdditive();
    this.expect(";", "after channel declaration");
    return { name: name.text, count, size, loc: this.span(kw.loc) };
  }

  private parseProcDef(): ProcDef {
    const name = this.expectId("process name");
    const params: string[] = [];
    if (this.accept("(")) {
      if (!this.at(")")) {
        do {
          params.push(this.expectId("parameter").text);
          if (this.at(":")) this.parseVarRange(); // parameter ranges: accepted, unchecked
        } while (this.accept(","));
      }
      this.expect(")");
    }
    this.expect("=", `after process name '${name.text}'`);
    const body = this.parseInterleave();
    this.expect(";", `to end the definition of '${name.text}'`);
    return { name: name.text, params, body, loc: this.span(name.loc) };
  }

  // -- processes ------------------------------------------------------------

  /** paralDef (';' paralDef)* */
  private parseRanges(): Range[] {
    const ranges: Range[] = [this.parseRange()];
    while (this.at(";") && this.atId(1) && this.at(":", 2)) {
      this.advance();
      ranges.push(this.parseRange());
    }
    return ranges;
  }

  private parseRange(): Range {
    const v = this.expectId("index variable");
    this.expect(":");
    this.expect("{");
    const first = this.parseAdditive();
    if (this.accept("..")) {
      const to = this.parseAdditive();
      this.expect("}");
      return { kind: "range", v: v.text, from: first, to };
    }
    const items = [first];
    while (this.accept(",")) items.push(this.parseAdditive());
    this.expect("}");
    return { kind: "set", v: v.text, items };
  }

  private parseInterleave(): Proc {
    const start = this.peek().loc;
    if (this.at("|||")) {
      this.advance();
      if (this.at("{")) {
        // paralDef2: '{' '..' '}' | '{' expr '}'
        this.advance();
        let count: Expr | "inf";
        if (this.accept("..")) count = "inf";
        else count = this.parseAdditive();
        this.expect("}");
        this.expect("@");
        const body = this.parseInterleave();
        return { k: "replicate", id: this.id(), op: "|||", count, body, loc: this.span(start) };
      }
      const ranges = this.parseRanges();
      this.expect("@");
      const body = this.parseInterleave();
      return { k: "indexed", id: this.id(), op: "|||", ranges, body, loc: this.span(start) };
    }
    const first = this.parseParallel();
    if (!this.at("|||")) return first;
    const ps = [first];
    while (this.accept("|||")) ps.push(this.parseParallel());
    return { k: "par", id: this.id(), op: "|||", ps, loc: this.span(start) };
  }

  private parseParallel(): Proc {
    const start = this.peek().loc;
    if (this.at("||")) {
      this.advance();
      if (this.at("{")) {
        this.advance();
        let count: Expr | "inf";
        if (this.accept("..")) count = "inf";
        else count = this.parseAdditive();
        this.expect("}");
        this.expect("@");
        const body = this.parseInterleave();
        return { k: "replicate", id: this.id(), op: "||", count, body, loc: this.span(start) };
      }
      const ranges = this.parseRanges();
      this.expect("@");
      const body = this.parseInterleave();
      return { k: "indexed", id: this.id(), op: "||", ranges, body, loc: this.span(start) };
    }
    const first = this.parseGeneralChoice();
    if (!this.at("||")) return first;
    const ps = [first];
    while (this.accept("||")) ps.push(this.parseGeneralChoice());
    return { k: "par", id: this.id(), op: "||", ps, loc: this.span(start) };
  }

  private parseChoiceLevel(
    op: "[]" | "<>" | "[*]",
    inner: () => Proc,
  ): Proc {
    const start = this.peek().loc;
    if (this.at(op)) {
      this.advance();
      const ranges = this.parseRanges();
      this.expect("@");
      const body = this.parseInterleave();
      return { k: "indexed", id: this.id(), op, ranges, body, loc: this.span(start) };
    }
    const first = inner();
    if (!this.at(op)) return first;
    const ps = [first];
    while (this.accept(op)) ps.push(inner());
    return { k: "choice", id: this.id(), op, ps, loc: this.span(start) };
  }

  private parseGeneralChoice(): Proc {
    return this.parseChoiceLevel("[]", () => this.parseInternalChoice());
  }
  private parseInternalChoice(): Proc {
    return this.parseChoiceLevel("<>", () => this.parseExternalChoice());
  }
  private parseExternalChoice(): Proc {
    return this.parseChoiceLevel("[*]", () => this.parseInterrupt());
  }

  private parseInterrupt(): Proc {
    const start = this.peek().loc;
    let p = this.parseHiding();
    while (this.accept("interrupt")) {
      const q = this.parseHiding();
      p = { k: "interrupt", id: this.id(), p, q, loc: this.span(start) };
    }
    return p;
  }

  private parseHiding(): Proc {
    const start = this.peek().loc;
    const p = this.parseSequential();
    if (!this.at("\\")) return p;
    this.advance();
    this.expect("{", "after '\\'");
    const events: EventListItem[] = [];
    if (!this.at("}")) {
      events.push(this.parseEventListItem());
      while (this.accept(",")) events.push(this.parseEventListItem());
    }
    this.expect("}");
    return { k: "hide", id: this.id(), p, events, loc: this.span(start) };
  }

  private parseEventListItem(): EventListItem {
    let ranges: Range[] = [];
    if (this.atId() && this.at(":", 1)) {
      ranges = this.parseRanges();
      this.expect("@");
    }
    return { ranges, ev: this.parseEventName() };
  }

  /**
   * sequentialExpr: guardExpr (';' guardExpr)*
   * A ';' also terminates a process definition, so only continue when what
   * follows can start a process and is not the start of the next definition.
   */
  private parseSequential(): Proc {
    const start = this.peek().loc;
    const first = this.parseGuard();
    if (!(this.at(";") && this.continuesSequence())) return first;
    const ps = [first];
    while (this.at(";") && this.continuesSequence()) {
      this.advance();
      ps.push(this.parseGuard());
    }
    return { k: "seq", id: this.id(), ps, loc: this.span(start) };
  }

  private continuesSequence(): boolean {
    const t = this.peek(1);
    if (t.kind === "eof") return false;
    if (t.kind === "op") return t.text === "(" || t.text === "[" || t.text === "{";
    if (t.kind !== "id") return false;
    if (KEYWORDS.has(t.text)) {
      return ["Skip", "Stop", "if", "ifa", "ifb", "case", "atomic", "assert", "tau"].includes(t.text);
    }
    // ID '=' or ID '(' ... ')' '=' begins a new definition.
    if (this.at("=", 2)) return false;
    if (this.at("(", 2)) {
      let k = 3;
      let depth = 1;
      while (depth > 0 && this.peek(k).kind !== "eof") {
        if (this.at("(", k)) depth++;
        else if (this.at(")", k)) depth--;
        k++;
      }
      if (this.at("=", k)) return false;
    }
    return true;
  }

  private parseGuard(): Proc {
    const start = this.peek().loc;
    if (this.at("[")) {
      this.advance();
      const cond = this.parseConditionalOr();
      this.expect("]", "to close the guard");
      const body = this.parseChannelExpr();
      return { k: "guard", id: this.id(), cond, body, loc: this.span(start) };
    }
    return this.parseChannelExpr();
  }

  private parseChannelExpr(): Proc {
    const start = this.peek().loc;
    // c!... or c?... or c[i]!... or c[i]?...
    if (this.atId()) {
      const save = this.i;
      const name = this.advance();
      let index: Expr | undefined;
      if (this.at("[")) {
        // Could be a channel array index; try it.
        this.advance();
        try {
          index = this.parseAdditive();
          this.expect("]");
        } catch {
          this.i = save;
          return this.parseEventExpr();
        }
      }
      if (this.at("!")) {
        this.advance();
        const exprs = [this.parseExpression()];
        while (this.accept(".")) exprs.push(this.parseExpression());
        const loc = this.span(start);
        this.expect("->", "after channel output");
        const next = this.parseChannelExpr();
        return {
          k: "prefix", id: this.id(),
          ev: { k: "out", chan: name.text, index, exprs, loc },
          next, loc: this.span(start),
        };
      }
      if (this.at("?")) {
        this.advance();
        let guard: Expr | undefined;
        if (this.at("[")) {
          this.advance();
          guard = this.parseConditionalOr();
          this.expect("]");
        }
        const pats = [this.parseExpression()];
        while (this.accept(".")) pats.push(this.parseExpression());
        const loc = this.span(start);
        let block: Block | undefined;
        if (this.at("{")) block = this.parseBlock();
        this.expect("->", "after channel input");
        const next = this.parseChannelExpr();
        return {
          k: "prefix", id: this.id(),
          ev: { k: "in", chan: name.text, index, guard, pats, loc },
          block, next, loc: this.span(start),
        };
      }
      this.i = save;
    }
    return this.parseEventExpr();
  }

  private parseEventExpr(): Proc {
    const start = this.peek().loc;

    // block '->' P  (unlabelled program == tau{...} -> P)
    if (this.at("{")) {
      const block = this.parseBlock();
      this.expect("->", "after statement block");
      const next = this.parseChannelExpr();
      return { k: "prefix", id: this.id(), ev: { k: "tau" }, block, next, loc: this.span(start) };
    }

    // '(' eventM (',' eventM)* ')' '->' P
    if (this.at("(") && (this.atId(1) || this.at("tau", 1))) {
      const save = this.i;
      this.advance();
      try {
        const evs: Ev[] = [this.parseEventM()];
        if (this.at(",")) {
          while (this.accept(",")) evs.push(this.parseEventM());
          this.expect(")");
          this.expect("->");
          let next = this.parseChannelExpr();
          const loc = this.span(start);
          // (a, b) -> P is the events in sequence: a -> b -> P.
          for (let i = evs.length - 1; i >= 0; i--) {
            next = { k: "prefix", id: this.id(), ev: evs[i], next, loc };
          }
          return next;
        }
      } catch {
        /* fall through: it was a parenthesised process */
      }
      this.i = save;
    }

    // eventM block? '->' P
    if (this.atId() || this.at("tau")) {
      const save = this.i;
      let ev: Ev | null = null;
      try {
        ev = this.parseEventM();
      } catch {
        ev = null;
      }
      if (ev && (this.at("{") || this.at("->"))) {
        let block: Block | undefined;
        if (this.at("{")) block = this.parseBlock();
        this.expect("->", "after event");
        const next = this.parseChannelExpr();
        return { k: "prefix", id: this.id(), ev, block, next, loc: this.span(start) };
      }
      this.i = save;
    }

    return this.parseCaseExpr();
  }

  private parseEventM(): Ev {
    if (this.accept("tau")) return { k: "tau" };
    return { k: "event", ev: this.parseEventName() };
  }

  /** eventName: ID ('.' additiveExpression)* */
  private parseEventName(): EventName {
    const name = this.expectId("event name");
    const args: Expr[] = [];
    while (this.accept(".")) args.push(this.parseAdditive());
    return { name: name.text, args, loc: this.span(name.loc) };
  }

  private parseCaseExpr(): Proc {
    const start = this.peek().loc;
    if (this.at("case")) {
      this.advance();
      this.expect("{");
      const cases: { cond: Expr; body: Proc }[] = [];
      let def: Proc | undefined;
      while (!this.at("}")) {
        if (this.at("default")) {
          this.advance();
          this.expect(":");
          def = this.parseInterleave();
          break;
        }
        const cond = this.parseConditionalOr();
        this.expect(":", "after case condition");
        const body = this.parseInterleave();
        cases.push({ cond, body });
      }
      this.expect("}");
      if (cases.length === 0) throw new CspError("case needs at least one condition", this.span(start));
      return { k: "case", id: this.id(), cases, def, loc: this.span(start) };
    }
    return this.parseIfExpr();
  }

  private parseIfExpr(): Proc {
    const start = this.peek().loc;
    if (this.at("if") || this.at("ifa") || this.at("ifb")) {
      const variant = this.advance().text as "if" | "ifa" | "ifb";
      this.expect("(");
      const cond = this.parseConditionalOr();
      this.expect(")");
      this.expect("{", `after ${variant} condition`);
      const then = this.parseInterleave();
      this.expect("}");
      let els: Proc | undefined;
      if (variant !== "ifb" && this.accept("else")) {
        if (this.at("if") || this.at("ifa") || this.at("ifb")) {
          els = this.parseIfExpr();
        } else {
          this.expect("{", "after else");
          els = this.parseInterleave();
          this.expect("}");
        }
      }
      return { k: "if", id: this.id(), variant, cond, then, else: els, loc: this.span(start) };
    }
    return this.parseAtomicExpr();
  }

  private parseAtomicExpr(): Proc {
    const start = this.peek().loc;
    if (this.at("atomic")) {
      this.advance();
      this.expect("{");
      const p = this.parseInterleave();
      this.expect("}");
      return { k: "atomic", id: this.id(), p, loc: this.span(start) };
    }
    return this.parseAtom();
  }

  parseAtom(): Proc {
    const start = this.peek().loc;
    if (this.at("Skip") || this.at("Stop")) {
      const kw = this.advance();
      if (this.accept("(")) this.expect(")");
      return { k: kw.text === "Skip" ? "skip" : "stop", id: this.id(), loc: this.span(start) };
    }
    if (this.at("assert")) {
      this.advance();
      this.expect("(");
      const cond = this.parseExpression();
      this.expect(")");
      return { k: "assert", id: this.id(), cond, loc: this.span(start) };
    }
    if (this.at("(")) {
      this.advance();
      const p = this.parseInterleave();
      this.expect(")", "to close the parenthesised process");
      return p;
    }
    if (this.atId()) {
      const name = this.advance();
      const args: Expr[] = [];
      if (this.accept("(")) {
        if (!this.at(")")) {
          args.push(this.parseExpression());
          while (this.accept(",")) args.push(this.parseExpression());
        }
        this.expect(")");
      }
      return { k: "ref", id: this.id(), name: name.text, args, loc: this.span(start) };
    }
    const t = this.peek();
    throw new CspError(`expected a process but found '${t.text}'`, t.loc);
  }

  // -- statements -----------------------------------------------------------

  private parseBlock(): Block {
    const open = this.expect("{");
    const stmts: Stmt[] = [];
    let tail: Expr | undefined;
    while (!this.at("}")) {
      if (this.peek().kind === "eof") this.fail("unterminated block");
      if (this.at(";")) {
        this.advance();
        continue;
      }
      const start = this.peek().loc;
      if (this.at("{")) {
        const b = this.parseBlock();
        stmts.push({ k: "block", block: b, loc: b.loc });
        continue;
      }
      if (this.at("var")) {
        stmts.push(this.parseLocalVar());
        continue;
      }
      if (this.at("if")) {
        this.advance();
        this.expect("(");
        const cond = this.parseExpression();
        this.expect(")");
        const then = this.parseStatement();
        let els: Stmt | undefined;
        if (this.accept("else")) els = this.parseStatement();
        stmts.push({ k: "if", cond, then, else: els, loc: this.span(start) });
        continue;
      }
      if (this.at("while")) {
        this.advance();
        this.expect("(");
        const cond = this.parseExpression();
        this.expect(")");
        const body = this.parseStatement();
        stmts.push({ k: "while", cond, body, loc: this.span(start) });
        continue;
      }
      const e = this.parseExpression();
      if (this.accept(";")) {
        stmts.push({ k: "expr", e, loc: this.span(start) });
      } else if (this.at("}")) {
        tail = e; // the final semicolon is optional
      } else {
        this.fail(`expected ';' but found '${this.peek().text}'`);
      }
    }
    this.expect("}");
    return { stmts, tail, loc: this.span(open.loc) };
  }

  private parseStatement(): Stmt {
    const start = this.peek().loc;
    if (this.at("{")) {
      const b = this.parseBlock();
      return { k: "block", block: b, loc: b.loc };
    }
    if (this.at("var")) return this.parseLocalVar();
    if (this.at("if")) {
      this.advance();
      this.expect("(");
      const cond = this.parseExpression();
      this.expect(")");
      const then = this.parseStatement();
      let els: Stmt | undefined;
      if (this.accept("else")) els = this.parseStatement();
      return { k: "if", cond, then, else: els, loc: this.span(start) };
    }
    if (this.at("while")) {
      this.advance();
      this.expect("(");
      const cond = this.parseExpression();
      this.expect(")");
      const body = this.parseStatement();
      return { k: "while", cond, body, loc: this.span(start) };
    }
    if (this.accept(";")) return { k: "block", block: { stmts: [], loc: this.span(start) }, loc: this.span(start) };
    const e = this.parseExpression();
    this.expect(";", "after statement");
    return { k: "expr", e, loc: this.span(start) };
  }

  private parseLocalVar(): Stmt {
    const start = this.expect("var").loc;
    const name = this.expectId("variable name");
    let dims: Expr[] | undefined;
    while (this.at("[")) {
      this.advance();
      (dims ??= []).push(this.parseExpression());
      this.expect("]");
    }
    let init: Expr | undefined;
    if (this.accept("=")) init = this.at("[") ? this.parseRecord() : this.parseExpression();
    this.expect(";", "after local variable");
    return { k: "local", name: name.text, dims, init, loc: this.span(start) };
  }

  // -- expressions ----------------------------------------------------------

  private parseArgument(): Expr {
    return this.at("[") ? this.parseRecord() : this.parseConditionalOr();
  }

  private parseRecord(): Expr {
    const start = this.expect("[").loc;
    const elems: RecordElem[] = [];
    if (!this.at("]")) {
      do {
        const e = this.parseExpression();
        if (this.accept("..")) {
          elems.push({ kind: "span", from: e, to: this.parseExpression() });
        } else if (this.at("(")) {
          this.advance();
          const count = this.parseExpression();
          this.expect(")");
          elems.push({ kind: "item", e, count });
        } else {
          elems.push({ kind: "item", e });
        }
      } while (this.accept(","));
    }
    this.expect("]");
    return { k: "record", elems, loc: this.span(start) };
  }

  /** expression: conditionalOrExpression ('=' expression)? */
  parseExpression(): Expr {
    const start = this.peek().loc;
    const l = this.parseConditionalOr();
    if (this.at("=")) {
      this.advance();
      const value = this.parseExpression();
      if (l.k !== "id" && l.k !== "index") {
        throw new CspError("only variables and array elements can be assigned", l.loc);
      }
      return { k: "assign", target: l, value, loc: this.span(start) };
    }
    return l;
  }

  private parseIndexedExpr(op: "&&" | "||" | "xor", start: Loc): Expr {
    const ranges = this.parseRanges();
    this.expect("@");
    const body = this.parseConditionalOr();
    return { k: "indexed", op, ranges, body, loc: this.span(start) };
  }

  private parseConditionalOr(): Expr {
    const start = this.peek().loc;
    if (this.at("||")) {
      this.advance();
      return this.parseIndexedExpr("||", start);
    }
    let l = this.parseConditionalAnd();
    while (this.at("||")) {
      this.advance();
      l = { k: "bin", op: "||", l, r: this.parseConditionalAnd(), loc: this.span(start) };
    }
    return l;
  }

  private parseConditionalAnd(): Expr {
    const start = this.peek().loc;
    if (this.at("&&")) {
      this.advance();
      return this.parseIndexedExpr("&&", start);
    }
    let l = this.parseXor();
    while (this.at("&&")) {
      this.advance();
      l = { k: "bin", op: "&&", l, r: this.parseXor(), loc: this.span(start) };
    }
    return l;
  }

  private parseXor(): Expr {
    const start = this.peek().loc;
    if (this.at("xor")) {
      this.advance();
      return this.parseIndexedExpr("xor", start);
    }
    let l = this.parseBitwise();
    while (this.at("xor")) {
      this.advance();
      l = { k: "bin", op: "xor", l, r: this.parseBitwise(), loc: this.span(start) };
    }
    return l;
  }

  private parseBitwise(): Expr {
    const start = this.peek().loc;
    let l = this.parseEquality();
    while (this.at("&") || this.at("|") || this.at("^")) {
      const op = this.advance().text as "&" | "|" | "^";
      l = { k: "bin", op, l, r: this.parseEquality(), loc: this.span(start) };
    }
    return l;
  }

  private parseEquality(): Expr {
    const start = this.peek().loc;
    let l = this.parseRelational();
    while (this.at("==") || this.at("!=")) {
      const op = this.advance().text as "==" | "!=";
      l = { k: "bin", op, l, r: this.parseRelational(), loc: this.span(start) };
    }
    return l;
  }

  private parseRelational(): Expr {
    const start = this.peek().loc;
    let l = this.parseAdditive();
    while (this.at("<") || this.at(">") || this.at("<=") || this.at(">=")) {
      const op = this.advance().text as "<" | ">" | "<=" | ">=";
      l = { k: "bin", op, l, r: this.parseAdditive(), loc: this.span(start) };
    }
    return l;
  }

  parseAdditive(): Expr {
    const start = this.peek().loc;
    let l = this.parseMultiplicative();
    while (this.at("+") || this.at("-")) {
      const op = this.advance().text as "+" | "-";
      l = { k: "bin", op, l, r: this.parseMultiplicative(), loc: this.span(start) };
    }
    return l;
  }

  private parseMultiplicative(): Expr {
    const start = this.peek().loc;
    let l = this.parseUnary();
    while (this.at("*") || this.at("/") || this.at("%")) {
      const op = this.advance().text as "*" | "/" | "%";
      l = { k: "bin", op, l, r: this.parseUnary(), loc: this.span(start) };
    }
    return l;
  }

  private parseUnary(): Expr {
    const start = this.peek().loc;
    if (this.at("+") || this.at("-") || this.at("!")) {
      const op = this.advance().text as "+" | "-" | "!";
      const e = this.parseUnary();
      return { k: "unary", op, e, loc: this.span(start) };
    }
    const e = this.parsePrimary();
    if (this.at("++") || this.at("--")) {
      const t = this.advance();
      if (e.k !== "id" && e.k !== "index") throw new CspError(`'${t.text}' needs a variable`, e.loc);
      return { k: "postfix", target: e, delta: t.text === "++" ? 1 : -1, loc: this.span(start) };
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    const start = t.loc;
    if (t.kind === "int") {
      this.advance();
      return { k: "int", v: parseInt(t.text, 10), loc: t.loc };
    }
    if (this.at("true") || this.at("false")) {
      this.advance();
      return { k: "bool", v: t.text === "true", loc: t.loc };
    }
    if (this.at("call")) {
      this.advance();
      this.expect("(");
      const name = this.expectId("function name");
      const args: Expr[] = [];
      while (this.accept(",")) args.push(this.parseArgument());
      this.expect(")");
      return { k: "call", name: name.text, args, loc: this.span(start) };
    }
    if (this.at("new")) this.fail("user-defined types (new …) are not supported");
    if (this.at("(")) {
      this.advance();
      const e = this.parseExpression();
      this.expect(")");
      return e;
    }
    if (this.atId()) {
      this.advance();
      if (this.at("[")) {
        const idx: Expr[] = [];
        while (this.at("[")) {
          this.advance();
          idx.push(this.parseConditionalOr());
          this.expect("]");
        }
        this.checkNoMethodCall();
        return { k: "index", name: t.text, idx, loc: this.span(start) };
      }
      this.checkNoMethodCall();
      return { k: "id", name: t.text, loc: t.loc };
    }
    throw new CspError(`expected an expression but found '${t.text}'`, t.loc);
  }

  private checkNoMethodCall() {
    if ((this.at(".") && this.atId(1) && this.at("(", 2)) || this.at("$")) {
      this.fail("method calls on user-defined types are not supported");
    }
  }
}

export function parseSpec(src: string): Spec {
  return new Parser(src).parseSpec();
}

/** Parse a process expression on its own, e.g. the process to simulate. */
export function parseProcessRef(src: string): { name: string; args: Expr[] } {
  const p = new Parser(src);
  const proc = p.parseAtom();
  if (proc.k !== "ref") throw new CspError("expected a process reference like P() or P(1, 2)", proc.loc);
  const rest = p.peek();
  if (rest.kind !== "eof") throw new CspError(`unexpected '${rest.text}'`, rest.loc);
  return { name: proc.name, args: proc.args };
}
