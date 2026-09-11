/**
 * CSP# abstract syntax, following the grammar in the PAT 3.5 user manual
 * (section 3.1.1.5, "Grammar Rules"). Names of the node kinds mirror the
 * grammar's non-terminals where that helps map one onto the other.
 */

export type Loc = { pos: number; end: number; line: number; col: number };

// ---------------------------------------------------------------------------
// Expressions (the C#-like sequential sublanguage)
// ---------------------------------------------------------------------------

/** `x:{a, b, c}` or `x:{lo..hi}` — the paralDef non-terminal. */
export type Range =
  | { kind: "set"; v: string; items: Expr[] }
  | { kind: "range"; v: string; from: Expr; to: Expr };

/** Elements of a record expression `[1(2), 3..6, 7]`. */
export type RecordElem =
  | { kind: "item"; e: Expr; count?: Expr }
  | { kind: "span"; from: Expr; to: Expr };

export type Expr =
  | { k: "int"; v: number; loc: Loc }
  | { k: "bool"; v: boolean; loc: Loc }
  | { k: "id"; name: string; loc: Loc }
  | { k: "index"; name: string; idx: Expr[]; loc: Loc }
  | { k: "unary"; op: "+" | "-" | "!"; e: Expr; loc: Loc }
  | { k: "postfix"; target: Expr; delta: 1 | -1; loc: Loc }
  | { k: "bin"; op: BinOp; l: Expr; r: Expr; loc: Loc }
  | { k: "assign"; target: Expr; value: Expr; loc: Loc }
  | { k: "call"; name: string; args: Expr[]; loc: Loc }
  | { k: "indexed"; op: "&&" | "||" | "xor"; ranges: Range[]; body: Expr; loc: Loc }
  | { k: "record"; elems: RecordElem[]; loc: Loc };

export type BinOp =
  | "||" | "&&" | "xor"
  | "&" | "|" | "^"
  | "==" | "!="
  | "<" | ">" | "<=" | ">="
  | "+" | "-" | "*" | "/" | "%";

export type Stmt =
  | { k: "block"; block: Block; loc: Loc }
  | { k: "local"; name: string; dims?: Expr[]; init?: Expr; loc: Loc }
  | { k: "if"; cond: Expr; then: Stmt; else?: Stmt; loc: Loc }
  | { k: "while"; cond: Expr; body: Stmt; loc: Loc }
  | { k: "expr"; e: Expr; loc: Loc };

/** `{ statement* expression? }` — the tail expression needs no semicolon. */
export type Block = { stmts: Stmt[]; tail?: Expr; loc: Loc };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** `name.e1.e2` — eventName. */
export type EventName = { name: string; args: Expr[]; loc: Loc };

export type Ev =
  | { k: "event"; ev: EventName }
  | { k: "tau" }
  /** `c!e1.e2` or `c[i]!e` */
  | { k: "out"; chan: string; index?: Expr; exprs: Expr[]; loc: Loc }
  /** `c?x.y`, `c?1`, `c?[guard]x.y` */
  | { k: "in"; chan: string; index?: Expr; guard?: Expr; pats: Expr[]; loc: Loc };

/** An entry of an event list in hiding or `#alphabet`: `a.x` or `x:{0..N}@a.x`. */
export type EventListItem = { ranges: Range[]; ev: EventName };

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export type ChoiceOp = "[]" | "[*]" | "<>";
export type ParOp = "||" | "|||";

export type Proc =
  | { k: "stop"; id: number; loc: Loc }
  | { k: "skip"; id: number; loc: Loc }
  | { k: "prefix"; id: number; ev: Ev; block?: Block; next: Proc; loc: Loc }
  | { k: "ref"; id: number; name: string; args: Expr[]; loc: Loc }
  | { k: "guard"; id: number; cond: Expr; body: Proc; loc: Loc }
  | { k: "seq"; id: number; ps: Proc[]; loc: Loc }
  | { k: "choice"; id: number; op: ChoiceOp; ps: Proc[]; loc: Loc }
  | { k: "par"; id: number; op: ParOp; ps: Proc[]; loc: Loc }
  /** `op x:{..}; y:{..} @ P` for op in ||| || [] [*] <> */
  | { k: "indexed"; id: number; op: ChoiceOp | ParOp; ranges: Range[]; body: Proc; loc: Loc }
  /** `||| {n} @ P` or `||| {..} @ P` */
  | { k: "replicate"; id: number; op: ParOp; count: Expr | "inf"; body: Proc; loc: Loc }
  | { k: "interrupt"; id: number; p: Proc; q: Proc; loc: Loc }
  | { k: "hide"; id: number; p: Proc; events: EventListItem[]; loc: Loc }
  | { k: "if"; id: number; variant: "if" | "ifa" | "ifb"; cond: Expr; then: Proc; else?: Proc; loc: Loc }
  | { k: "case"; id: number; cases: { cond: Expr; body: Proc }[]; def?: Proc; loc: Loc }
  | { k: "atomic"; id: number; p: Proc; loc: Loc }
  | { k: "assert"; id: number; cond: Expr; loc: Loc };

// ---------------------------------------------------------------------------
// Specification
// ---------------------------------------------------------------------------

export type Define = {
  name: string;
  params?: string[];
  body: { k: "expr"; e: Expr } | { k: "block"; b: Block };
  loc: Loc;
};

export type VarRange = { lo?: Expr; hi?: Expr };

export type VarDecl = {
  name: string;
  hidden: boolean;
  dims?: Expr[];
  init?: Expr;
  range?: VarRange;
  loc: Loc;
};

export type ChanDecl = { name: string; count?: Expr; size: Expr; loc: Loc };

export type ProcDef = { name: string; params: string[]; body: Proc; loc: Loc };

export type Assertion = { proc: { name: string; args: Expr[] }; text: string; loc: Loc };

export type Spec = {
  defines: Map<string, Define>;
  vars: VarDecl[];
  channels: ChanDecl[];
  procs: Map<string, ProcDef>;
  alphabets: Map<string, EventListItem[]>;
  asserts: Assertion[];
};

export class CspError extends Error {
  constructor(
    message: string,
    public loc?: Loc,
  ) {
    super(message);
    this.name = "CspError";
  }
}
