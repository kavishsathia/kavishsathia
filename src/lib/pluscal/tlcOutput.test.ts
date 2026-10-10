import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interpret, parseLocation, parseState, readToolOutput, translatorErrors } from "./tlcOutput";

// Real `tlc2.TLC -tool` output from the shipped tla2tools.jar (rev 94d0c50),
// paths sanitised. See wasm-src/pluscal/README.md.
const fixture = (name: string) =>
  interpret(readToolOutput(readFileSync(join(__dirname, "fixtures", `${name}.out`), "utf8").split("\n")));

describe("TLC -tool output", () => {
  it("a passing model: success, statistics, coverage", () => {
    const r = fixture("ok");
    expect(r.outcome).toEqual({ kind: "success" });
    expect(r.version).toMatch(/^TLC2 Version 2026\.10\.06/);
    expect(r.mode).toBe("model-check");
    expect(r.stats).toEqual({ generated: 6, distinct: 6, left: 0, depth: 6 });
    expect(r.trace).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.coverage.some((l) => l.startsWith("<Next line 6"))).toBe(true);
  });

  it("an invariant violation: headline and the full trace", () => {
    const r = fixture("invariant");
    expect(r.outcome).toEqual({ kind: "invariant", name: "MutualExclusion" });
    expect(r.headline).toBe("Invariant MutualExclusion is violated.");
    expect(r.trace?.states.map((s) => s.action)).toEqual([
      "Initial predicate", "a1(0)", "a2(0)", "a3(0)", "a1(1)", "a2(1)", "a3(1)",
    ]);
    const last = r.trace!.states[6];
    expect(last.index).toBe(7);
    expect(last.location).toEqual({ module: "Peterson", startLine: 38, startCol: 13, endLine: 41, endCol: 27 });
    expect(last.vars).toEqual([
      { name: "flag", value: "(0 :> TRUE @@ 1 :> TRUE)" },
      { name: "pc", value: '(0 :> "cs" @@ 1 :> "cs")' },
      { name: "turn", value: "0" },
    ]);
    expect(r.trace!.ending).toBeNull();
    expect(r.stats.distinct).toBe(24);
  });

  it("a deadlock, with a one-variable spec (no conjunction list)", () => {
    const r = fixture("deadlock");
    expect(r.outcome).toEqual({ kind: "deadlock" });
    expect(r.trace?.states.map((s) => s.vars)).toEqual([
      [{ name: "x", value: "0" }],
      [{ name: "x", value: "1" }],
      [{ name: "x", value: "2" }],
    ]);
  });

  it("a liveness counterexample that stutters", () => {
    const r = fixture("liveness");
    expect(r.outcome).toEqual({ kind: "temporal", name: "Reaches" });
    expect(r.trace?.ending).toEqual({ kind: "stuttering" });
    expect(r.trace?.states.length).toBe(3);
  });

  it("a liveness counterexample that loops (lasso)", () => {
    const r = fixture("lasso");
    expect(r.outcome).toEqual({ kind: "temporal", name: "Reaches" });
    expect(r.trace?.states.map((s) => s.vars[0].value)).toEqual(["0", "1", "2"]);
    expect(r.trace?.ending).toEqual({
      kind: "back-to",
      index: 1,
      action: "Next",
      location: { module: "Cycle", startLine: 5, startCol: 9, endLine: 5, endCol: 24 },
    });
  });

  it("a SANY semantic error, located", () => {
    const r = fixture("sany");
    expect(r.outcome).toEqual({ kind: "parse-error" });
    expect(r.errors).toEqual([
      {
        message: "Unknown operator: `undefinedThing'.",
        location: { module: "Sany", startLine: 5, startCol: 18, endLine: 5, endCol: 31 },
        source: "sany",
      },
    ]);
  });

  it("a SANY parse error, located", () => {
    const r = fixture("parse");
    expect(r.outcome).toEqual({ kind: "parse-error" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('Encountered "0" at line 4, column 15');
    expect(r.errors[0].location).toEqual({ module: "Parse", startLine: 4, startCol: 15, endLine: 4, endCol: 15 });
  });

  it("an evaluation error: located by its innermost nested expression, with the trace so far", () => {
    const r = fixture("eval");
    expect(r.outcome.kind).toBe("error");
    expect(r.errors[0].message).toContain("Attempted to access index 3 of tuple");
    expect(r.errors[0].location).toEqual({ module: "Eval", startLine: 5, startCol: 24, endLine: 5, endCol: 27 });
    expect(r.trace?.states.length).toBe(1);
  });

  it("strips the framing for the console view", () => {
    const r = fixture("deadlock");
    expect(r.console.some((l) => l.includes("@!@!@"))).toBe(false);
    expect(r.console).toContain("Deadlock reached.");
  });
});

describe("pieces", () => {
  it("parses both location spellings", () => {
    expect(parseLocation("line 1, col 2 to line 3, col 4 of module M")).toEqual({
      module: "M", startLine: 1, startCol: 2, endLine: 3, endCol: 4,
    });
    expect(parseLocation("0. Line 5, column 9 to line 5, column 28 in Eval")).toEqual({
      module: "Eval", startLine: 5, startCol: 9, endLine: 5, endCol: 28,
    });
  });

  it("joins values TLC wraps over several lines", () => {
    const s = parseState('3: <Next line 1, col 1 to line 1, col 2 of module M>\n/\\ a = [x |-> 1,\n      y |-> 2]\n/\\ b = 0');
    expect(s?.vars).toEqual([
      { name: "a", value: "[x |-> 1,\n      y |-> 2]" },
      { name: "b", value: "0" },
    ]);
  });

  it("locates translator errors", () => {
    expect(
      translatorErrors(['\nUnrecoverable error:\n -- Expected "while" but found "whilst"\n    line 13, column 7.\n']),
    ).toEqual([
      {
        message: 'Expected "while" but found "whilst"\n    line 13, column 7.',
        location: { module: "", startLine: 13, startCol: 7, endLine: 13, endCol: 7 },
        source: "pcal",
      },
    ]);
    expect(translatorErrors(["Parsing completed.", "Translation completed."])).toEqual([]);
  });
});
