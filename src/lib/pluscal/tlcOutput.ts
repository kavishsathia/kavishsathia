/**
 * Reads TLC's `-tool` output — the framing the Toolbox and the VS Code
 * extension consume — into a structured report: outcome, statistics, the
 * error trace, and source-located errors.
 *
 *   @!@!@STARTMSG <code>:<severity> @!@!@
 *   ...body...
 *   @!@!@ENDMSG <code> @!@!@
 *
 * Codes are TLC's `tlc2.output.EC` constants; severities are `MP`'s (0 info,
 * 1 error, 2 TLC bug, 3 warning, 4 state). Lines outside any frame are SANY's
 * own output (parse and semantic errors among them). Messages can nest:
 * an error frame may wrap the frame of the error that caused it.
 */

export const EC = {
  GENERAL: 1000,
  OUT_OF_MEMORY: 1001,
  STACK_OVERFLOW: 1005,
  NESTED_EXPRESSION: 2103,
  ASSUMPTION_FALSE: 2104,
  ASSUMPTION_EVALUATION_ERROR: 2105,
  STATE_NOT_COMPLETELY_SPECIFIED_INITIAL: 2106,
  INVARIANT_VIOLATED_INITIAL: 2107,
  STATE_NOT_COMPLETELY_SPECIFIED_NEXT: 2109,
  INVARIANT_VIOLATED_BEHAVIOR: 2110,
  ACTION_PROPERTY_VIOLATED_BEHAVIOR: 2112,
  DEADLOCK_REACHED: 2114,
  TEMPORAL_PROPERTY_VIOLATED: 2116,
  NO_STATES_SATISFYING_INIT: 2118,
  BEHAVIOR_UP_TO_THIS_POINT: 2121,
  BACK_TO_STATE: 2122,
  BUG: 2128,
  VALUE_ASSERT_FAILED: 2132,
  INVARIANT_VIOLATED_LEVEL: 2146,
  STARTING: 2185,
  FINISHED: 2186,
  MODE_MC: 2187,
  MODE_SIMU: 2188,
  COMPUTING_INIT: 2189,
  INIT_GENERATED1: 2190,
  CHECKING_TEMPORAL_PROPS: 2192,
  SUCCESS: 2193,
  SEARCH_DEPTH: 2194,
  STATS: 2199,
  PROGRESS_STATS: 2200,
  COVERAGE_START: 2201,
  COVERAGE_END: 2202,
  PROGRESS_SIMU: 2209,
  STATE_PRINT2: 2217,
  STATE_PRINT3: 2218,
  SANY_END: 2219,
  SANY_START: 2220,
  VERSION: 2262,
  COUNTER_EXAMPLE: 2264,
  CHECKING_TEMPORAL_PROPS_END: 2267,
  PARSING_FAILED: 3002,
} as const;

export const SEVERITY = { INFO: 0, ERROR: 1, BUG: 2, WARNING: 3, STATE: 4 } as const;

export type Message = {
  code: number;
  severity: number;
  /** The message text, nested frames removed, trailing blank lines trimmed. */
  body: string;
};

/** Either a framed message, or a line printed outside any frame. */
export type Item = { kind: "message"; message: Message } | { kind: "plain"; line: string };

const START = /^@!@!@STARTMSG (\d+):(\d+) @!@!@$/;
const END = /^@!@!@ENDMSG (\d+) @!@!@$/;

/** Incremental: feed lines as TLC prints them. */
export class ToolOutputReader {
  readonly items: Item[] = [];
  private stack: { code: number; severity: number; lines: string[] }[] = [];

  push(line: string): Item | null {
    const start = START.exec(line);
    if (start) {
      this.stack.push({ code: Number(start[1]), severity: Number(start[2]), lines: [] });
      return null;
    }
    const end = END.exec(line);
    if (end && this.stack.length > 0) {
      const frame = this.stack.pop()!;
      const lines = frame.lines;
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      const item: Item = {
        kind: "message",
        message: { code: frame.code, severity: frame.severity, body: lines.join("\n") },
      };
      this.items.push(item);
      return item;
    }
    if (this.stack.length > 0) {
      this.stack[this.stack.length - 1].lines.push(line);
      return null;
    }
    const item: Item = { kind: "plain", line };
    this.items.push(item);
    return item;
  }
}

export function readToolOutput(lines: string[]): Item[] {
  const r = new ToolOutputReader();
  for (const l of lines) r.push(l);
  return r.items;
}

/** 1-based, inclusive, as TLC and SANY print them. */
export type Location = {
  module: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
};

const LOC_SHORT = /line (\d+), col (\d+) to line (\d+), col (\d+) of module (\w+)/;
const LOC_LONG = /[Ll]ine (\d+), column (\d+) to line (\d+), column (\d+) in (\w+)/;

export function parseLocation(text: string): Location | null {
  const m = LOC_SHORT.exec(text) ?? LOC_LONG.exec(text);
  if (!m) return null;
  return {
    startLine: Number(m[1]),
    startCol: Number(m[2]),
    endLine: Number(m[3]),
    endCol: Number(m[4]),
    module: m[5],
  };
}

export type Assignment = { name: string; value: string };

export type TraceState = {
  /** TLC's 1-based state number. */
  index: number;
  /** "Initial predicate", or the action's name (e.g. `a2(0)`, `Next`). */
  action: string;
  location: Location | null;
  vars: Assignment[];
};

export type Trace = {
  states: TraceState[];
  /**
   * How a liveness counterexample ends: it loops back to an earlier state
   * (a lasso), or it stutters forever in its last state.
   */
  ending: { kind: "back-to"; index: number; action: string; location: Location | null } | { kind: "stuttering" } | null;
};

/**
 * One TLC state print:
 *
 *   2: <a1(0) line 29, col 13 to line 31, col 41 of module Peterson>
 *   /\ flag = (0 :> FALSE @@ 1 :> FALSE)
 *   /\ pc = (0 :> "a2" @@ 1 :> "a1")
 *
 * A single-variable spec prints `x = 1` without the conjunction. Values can
 * span lines (TLC wraps long ones); continuation lines don't start a new
 * conjunct.
 */
export function parseState(body: string): TraceState | null {
  const lines = body.split("\n");
  const head = /^(\d+): <(.*)>\s*$/.exec(lines[0] ?? "");
  if (!head) return null;
  const label = head[2];
  const location = parseLocation(label);
  const action = location ? label.slice(0, label.indexOf(" line ")).trim() : label.trim();
  const vars: Assignment[] = [];
  const rest = lines.slice(1);
  const conj = rest.some((l) => l.startsWith("/\\ "));
  for (const line of rest) {
    if (line.trim() === "") continue;
    const m = conj ? /^\/\\ ([A-Za-z_][\w]*) = (.*)$/.exec(line) : vars.length === 0 ? /^([A-Za-z_][\w]*) = (.*)$/.exec(line) : null;
    if (m) {
      vars.push({ name: m[1], value: m[2] });
    } else if (vars.length > 0) {
      vars[vars.length - 1].value += "\n" + line;
    }
  }
  return { index: Number(head[1]), action, location, vars };
}

export type Outcome =
  | { kind: "running" }
  | { kind: "success" }
  | { kind: "invariant"; name: string }
  | { kind: "action-property"; name: string }
  | { kind: "temporal"; name: string }
  | { kind: "deadlock" }
  | { kind: "assumption"; text: string }
  | { kind: "no-initial-states" }
  | { kind: "error"; text: string }
  | { kind: "parse-error" }
  | { kind: "finished" };

export type SourceError = {
  message: string;
  location: Location | null;
  /** Which tool reported it: the PlusCal translator, the TLA+ parser, or the model checker. */
  source: "pcal" | "sany" | "tlc";
};

export type Stats = {
  generated: number | null;
  distinct: number | null;
  left: number | null;
  depth: number | null;
};

export type Report = {
  version: string | null;
  mode: "model-check" | "simulate" | null;
  /** The mode line: workers, seed, fingerprint, heap. */
  modeLine: string | null;
  outcome: Outcome;
  /** The violation (or failure) headline, as TLC phrased it. */
  headline: string | null;
  stats: Stats;
  durationText: string | null;
  trace: Trace | null;
  errors: SourceError[];
  warnings: string[];
  coverage: string[];
  /** Output with framing stripped, for the console view. */
  console: string[];
};

const num = (s: string) => Number(s.replace(/,/g, ""));

/**
 * SANY's errors, printed outside the framing. Semantic errors look like
 *
 *   *** Errors: 1
 *   line 5, col 18 to line 5, col 31 of module Sany
 *   Unknown operator: `undefinedThing'.
 *
 * and parse errors like
 *
 *   ***Parse Error***
 *   Was expecting "==== or more Module body"
 *   Encountered "0" at line 4, column 15 and token "="
 */
function sanyErrors(plain: string[]): SourceError[] {
  const out: SourceError[] = [];
  for (let i = 0; i < plain.length; i++) {
    const line = plain[i];
    if (line.startsWith("***Parse Error***")) {
      const block: string[] = [];
      let j = i + 1;
      for (; j < plain.length && !/^Residual stack trace|^Fatal errors|^\*\*\*/.test(plain[j]); j++) block.push(plain[j]);
      const text = block.join("\n").trim();
      const at = /at line (\d+), column (\d+)/.exec(text);
      const mod = plain.slice(j).join("\n").match(/Could not parse module (\w+)/);
      out.push({
        message: text,
        location: at
          ? { module: mod ? mod[1] : "", startLine: Number(at[1]), startCol: Number(at[2]), endLine: Number(at[1]), endCol: Number(at[2]) }
          : null,
        source: "sany",
      });
      i = j - 1;
      continue;
    }
    if (/^\*\*\* Errors: \d+/.test(line)) {
      // (location, message) pairs, blank lines around each part.
      const isLoc = (l: string) => /^\s*line \d+, col \d+ to line \d+, col \d+ of module \w+/.test(l);
      const skipBlank = (j: number) => {
        while (j < plain.length && plain[j].trim() === "") j++;
        return j;
      };
      let j = skipBlank(i + 1);
      while (j < plain.length && isLoc(plain[j])) {
        const loc = parseLocation(plain[j]);
        const msg: string[] = [];
        let k = skipBlank(j + 1);
        for (; k < plain.length && plain[k].trim() !== "" && !isLoc(plain[k]); k++) msg.push(plain[k]);
        out.push({ message: msg.join("\n").trim(), location: loc, source: "sany" });
        j = skipBlank(k);
      }
    }
  }
  return out;
}

export function interpret(items: Item[]): Report {
  const report: Report = {
    version: null,
    mode: null,
    modeLine: null,
    outcome: { kind: "running" },
    headline: null,
    stats: { generated: null, distinct: null, left: null, depth: null },
    durationText: null,
    trace: null,
    errors: [],
    warnings: [],
    coverage: [],
    console: [],
  };
  const plain: string[] = [];
  let inCoverage = false;
  let pendingNested: Location[] = [];

  const ensureTrace = () => (report.trace ??= { states: [], ending: null });
  const setOutcome = (o: Outcome, headline: string) => {
    // The first violation wins; later errors (e.g. "behavior up to here") are context.
    if (report.outcome.kind === "running" || report.outcome.kind === "finished") {
      report.outcome = o;
      report.headline = headline;
    }
  };

  for (const item of items) {
    if (item.kind === "plain") {
      plain.push(item.line);
      report.console.push(item.line);
      continue;
    }
    const { code, severity, body } = item.message;
    if (body !== "") report.console.push(body);

    if (inCoverage && code !== EC.COVERAGE_END) {
      report.coverage.push(body);
      continue;
    }

    switch (code) {
      case EC.VERSION:
        report.version = body.trim();
        break;
      case EC.MODE_MC:
        report.mode = "model-check";
        report.modeLine = body.trim();
        break;
      case EC.MODE_SIMU:
        report.mode = "simulate";
        report.modeLine = body.trim();
        break;
      case EC.SUCCESS:
        setOutcome({ kind: "success" }, body.split("\n")[0]);
        break;
      case EC.INVARIANT_VIOLATED_BEHAVIOR:
      case EC.INVARIANT_VIOLATED_INITIAL:
      case EC.INVARIANT_VIOLATED_LEVEL: {
        const m = /Invariant (\S+) is violated/.exec(body);
        setOutcome({ kind: "invariant", name: m ? m[1] : "" }, body.split("\n")[0]);
        break;
      }
      case EC.ACTION_PROPERTY_VIOLATED_BEHAVIOR: {
        const m = /Action property (\S+) is violated/.exec(body);
        setOutcome({ kind: "action-property", name: m ? m[1] : "" }, body.split("\n")[0]);
        break;
      }
      case EC.TEMPORAL_PROPERTY_VIOLATED: {
        const m = /Temporal property (\S+) was violated/.exec(body);
        setOutcome({ kind: "temporal", name: m ? m[1] : "" }, body.split("\n")[0]);
        break;
      }
      case EC.DEADLOCK_REACHED:
        setOutcome({ kind: "deadlock" }, body.split("\n")[0]);
        break;
      case EC.ASSUMPTION_FALSE:
      case EC.ASSUMPTION_EVALUATION_ERROR:
        setOutcome({ kind: "assumption", text: body }, body.split("\n")[0]);
        report.errors.push({ message: body, location: parseLocation(body), source: "tlc" });
        break;
      case EC.NO_STATES_SATISFYING_INIT:
        setOutcome({ kind: "no-initial-states" }, body.split("\n")[0]);
        break;
      case EC.PARSING_FAILED:
        setOutcome({ kind: "parse-error" }, body.split("\n")[0]);
        break;
      case EC.STATE_PRINT2: {
        const s = parseState(body);
        if (s) ensureTrace().states.push(s);
        break;
      }
      case EC.STATE_PRINT3:
        ensureTrace().ending = { kind: "stuttering" };
        break;
      case EC.BACK_TO_STATE: {
        const m = /^(\d+): Back to state: <?(.*?)>?\s*$/.exec(body.split("\n")[0]);
        if (m) {
          const location = parseLocation(m[2]);
          const action = location ? m[2].slice(0, m[2].indexOf(" line ")).trim() : m[2].trim();
          ensureTrace().ending = { kind: "back-to", index: Number(m[1]), action, location };
        }
        break;
      }
      case EC.NESTED_EXPRESSION: {
        pendingNested = body
          .split("\n")
          .map(parseLocation)
          .filter((l): l is Location => l !== null);
        // Attach the innermost position to the evaluation error it explains.
        const last = [...report.errors].reverse().find((e) => e.source === "tlc");
        if (last && !last.location && pendingNested.length > 0) last.location = pendingNested[pendingNested.length - 1];
        break;
      }
      case EC.STATS: {
        const m = /([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/.exec(body);
        if (m) report.stats = { ...report.stats, generated: num(m[1]), distinct: num(m[2]), left: num(m[3]) };
        break;
      }
      case EC.PROGRESS_STATS: {
        const m = /([\d,]+) states generated.*?, ([\d,]+) distinct states found.*?, ([\d,]+) states left on queue/.exec(body);
        if (m) report.stats = { ...report.stats, generated: num(m[1]), distinct: num(m[2]), left: num(m[3]) };
        break;
      }
      case EC.SEARCH_DEPTH: {
        const m = /depth of the complete state graph search is (\d+)/.exec(body);
        if (m) report.stats = { ...report.stats, depth: Number(m[1]) };
        break;
      }
      case EC.FINISHED: {
        const m = /Finished in (.*?) at/.exec(body);
        report.durationText = m ? m[1] : null;
        if (report.outcome.kind === "running") report.outcome = { kind: "finished" };
        break;
      }
      case EC.COVERAGE_START:
        inCoverage = true;
        break;
      case EC.COVERAGE_END:
        inCoverage = false;
        break;
      default:
        if (severity === SEVERITY.WARNING) {
          report.warnings.push(body);
        } else if (severity === SEVERITY.ERROR || severity === SEVERITY.BUG) {
          if (code === EC.BEHAVIOR_UP_TO_THIS_POINT || code === EC.COUNTER_EXAMPLE) break;
          report.errors.push({ message: body, location: parseLocation(body), source: "tlc" });
          setOutcome({ kind: "error", text: body }, body.split("\n")[0]);
        }
    }
  }

  report.errors.unshift(...sanyErrors(plain));
  return report;
}

/** Translator (pcal.trans) messages carry "line L, column C." */
export function translatorErrors(messages: string[]): SourceError[] {
  const out: SourceError[] = [];
  for (const raw of messages) {
    const text = raw.trim();
    if (text === "" || /^(Parsing completed|Translation completed|New file .* written|File .* read only)/.test(text)) continue;
    const at = /line (\d+), column (\d+)/.exec(text);
    out.push({
      message: text.replace(/^Unrecoverable error:\s*/, "").replace(/^--\s*/, ""),
      location: at ? { module: "", startLine: Number(at[1]), startCol: Number(at[2]), endLine: Number(at[1]), endCol: Number(at[2]) } : null,
      source: "pcal",
    });
  }
  return out;
}
