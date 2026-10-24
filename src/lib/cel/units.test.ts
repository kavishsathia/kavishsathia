import { describe, expect, it } from "vitest";
import {
  classify,
  configIssues,
  conjoin,
  decodeWorkbench,
  defaultFallback,
  encodeWorkbench,
  evaluationExprs,
  exhaustiveQuery,
  fallbackDisjointQuery,
  fallbackPredicate,
  gapQuery,
  pairQuery,
  parseSchema,
  parseWitness,
  proofFingerprint,
  readEmptiness,
  readValidity,
  translationFingerprint,
  type Unit,
} from "./units";
import { unitExamples, workbenchFrom } from "./unitExamples";

const unit = (name: string, predicate: string, symbol = `ev.${name}`): Unit => ({ key: name, name, predicate, symbol });

describe("queries", () => {
  it("conjoins assumption and both predicates, each on its own lines", () => {
    const q = pairQuery("amount >= 0", unit("a", "x == 1 // one"), unit("b", "x == 2"));
    expect(q).toBe("(\namount >= 0\n) && (\nx == 1 // one\n) && (\nx == 2\n)");
  });
  it("treats an empty assumption as true", () => {
    expect(conjoin("", "p")).toBe("(\ntrue\n) && (\np\n)");
  });
});

describe("fallback and coverage queries", () => {
  const us = [unit("a", "x == 1 // one"), unit("b", "x == 2")];
  it("the fallback is the negated union of every explicit predicate", () => {
    expect(fallbackPredicate(us)).toBe("!(\n(\nx == 1 // one\n) || (\nx == 2\n)\n)");
    expect(fallbackPredicate([])).toBe("!(\nfalse\n)");
  });
  it("gap: the fallback under the assumption; disjointness: fallback and union together", () => {
    expect(gapQuery("A", us)).toBe(conjoin("A", fallbackPredicate(us)));
    expect(fallbackDisjointQuery("A", us)).toBe(
      conjoin("A", fallbackPredicate(us), "(\nx == 1 // one\n) || (\nx == 2\n)"),
    );
  });
  it("exhaustiveness: A implies some unit or the fallback, for isAlwaysTrue", () => {
    expect(exhaustiveQuery("A", us)).toBe(
      "!(\nA\n) || (\nx == 1 // one\n) || (\nx == 2\n) || (\n" + fallbackPredicate(us) + "\n)",
    );
  });
  it("the runtime evaluates the same generated fallback last", () => {
    expect(evaluationExprs("A", us)).toEqual(["A", "x == 1 // one", "x == 2", fallbackPredicate(us)]);
  });
});

describe("readEmptiness: cel-java isSatisfiable statuses", () => {
  const ok = (status: "VERIFIED" | "VIOLATED" | "INCONCLUSIVE", message: string) =>
    ({ ok: true, value: { status, reason: message, counterexample: "", message } }) as const;

  it("VIOLATED (not satisfiable) is the only proof of emptiness", () => {
    expect(readEmptiness(ok("VIOLATED", "Condition is not satisfiable.")).kind).toBe("proved");
  });
  it("VERIFIED (satisfiable) is an overlap, with the model as a witness", () => {
    const v = readEmptiness(
      ok("VERIFIED", 'Condition is satisfiable. Satisfying input:\n  amount = 100\n  tool = "transfer"'),
    );
    expect(v).toMatchObject({ kind: "refuted", witness: { amount: "100", tool: '"transfer"' } });
  });
  it("INCONCLUSIVE is not proven, never disjoint", () => {
    const v = readEmptiness(
      ok("INCONCLUSIVE", "Inconclusive: expression is not satisfiable within the current loop unroll limit"),
    );
    expect(v.kind).toBe("not-proven");
  });
  it("a thrown verifier (e.g. timeout) is an error", () => {
    const v = readEmptiness({
      ok: false,
      failure: { kind: "runtime", error: "x", rootError: "CelVerificationException: Verification timed out: timeout", stack: "" },
    });
    expect(v).toEqual({ kind: "error", detail: "CelVerificationException: Verification timed out: timeout" });
  });
});

describe("readValidity: cel-java isAlwaysTrue statuses", () => {
  const ok = (status: "VERIFIED" | "VIOLATED" | "INCONCLUSIVE", message: string) =>
    ({ ok: true, value: { status, reason: message, counterexample: "", message } }) as const;

  it("VERIFIED (no counterexample) proves the implication", () => {
    expect(readValidity(ok("VERIFIED", "")).kind).toBe("proved");
  });
  it("VIOLATED comes with the counterexample", () => {
    const v = readValidity(
      ok("VIOLATED", 'Condition is not always true. Counterexample input:\n  amount = 0\n  tool = "rate"'),
    );
    expect(v).toMatchObject({ kind: "refuted", witness: { amount: "0", tool: '"rate"' } });
  });
  it("INCONCLUSIVE is not proven, keeping the potential counterexample", () => {
    const v = readValidity(
      ok(
        "INCONCLUSIVE",
        "Inconclusive: a counterexample may exist, but it depends on approximations, missing theories, or loop bounds. Potential counterexample input:\n  amount = 3",
      ),
    );
    expect(v).toMatchObject({ kind: "not-proven", witness: { amount: "3" } });
  });
  it("a thrown verifier is an error", () => {
    const v = readValidity({
      ok: false,
      failure: { kind: "runtime", error: "x", rootError: "CelVerificationException: Verification timed out", stack: "" },
    });
    expect(v.kind).toBe("error");
  });
});

describe("parseWitness", () => {
  it("rewrites Z3 negatives and strings into CEL literals", () => {
    expect(parseWitness('Satisfying input:\n  n = (- 5)\n  s = "say ""hi"" \\u{e9}"\n  u = 3u')).toEqual({
      n: "-5",
      s: '"say \\"hi\\" é"',
      u: "3u",
    });
  });
  it("returns nothing when the model has no bindings", () => {
    expect(parseWitness("Condition is satisfiable. (The expression is satisfiable unconditionally)")).toEqual({});
  });
});

describe("parseSchema and configIssues", () => {
  it("reads name:type lines like the Java side, skipping comments", () => {
    expect(parseSchema("# c\ntool:string\n\namount: int").fields).toEqual([
      { name: "tool", type: "string" },
      { name: "amount", type: "int" },
    ]);
    expect(parseSchema("tool\n1x:int").errors).toHaveLength(2);
  });
  it("rejects colliding unit names and warns on shared output symbols", () => {
    const issues = configIssues({
      schema: "x:int",
      assumption: "",
      units: [unit("a", "x == 1", "ev"), { ...unit("a", "x == 2", "ev"), key: "a2" }],
      fallback: "other",
    });
    expect(issues.some((i) => i.severity === "error" && /used 2 times/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.severity === "warning" && /emit ev/.test(i.message))).toBe(true);
  });
  it("requires fixed CSP event names", () => {
    const issues = configIssues({ schema: "x:int", assumption: "", units: [unit("a", "x == 1", "ev?x")], fallback: "other" });
    expect(issues.map((i) => i.message).join()).toMatch(/fixed name/);
  });
  it("the fallback event must be a fixed name no explicit unit emits", () => {
    const base = { schema: "x:int", assumption: "", units: [unit("a", "x == 1", "other")] };
    expect(configIssues({ ...base, fallback: "other" })).toContainEqual({
      unit: "fallback",
      severity: "error",
      message: "fallback event other is also emitted by a; it must be a distinct CSP event",
    });
    expect(configIssues({ ...base, fallback: "" }).map((i) => i.message)).toContain(
      "fallback: CSP event must be a fixed name like other",
    );
    expect(configIssues({ ...base, fallback: "rest" })).toEqual([]);
  });
  it("defaults the fallback to other, avoiding explicit events", () => {
    expect(defaultFallback([])).toBe("other");
    expect(defaultFallback([{ symbol: "other" }, { symbol: "other_2" }])).toBe("other_3");
  });
  it("the bundled examples are well-formed", () => {
    for (const ex of unitExamples) {
      const w = workbenchFrom(ex);
      expect(configIssues(w).filter((i) => i.severity === "error")).toEqual([]);
      const names = parseSchema(w.schema).fields.map((f) => f.name);
      for (const e of w.events) expect(Object.keys(e.values).sort()).toEqual([...names].sort());
    }
  });
});

describe("classify", () => {
  const units = [unit("a", "x"), unit("b", "y"), unit("c", "z")];
  const t = { ok: true as const, value: true };
  const f = { ok: true as const, value: false };

  // results: [assumption, a, b, c, fallback]
  it("no match goes to the fallback; one match is mapped", () => {
    expect(classify({ inputErrors: [], results: [t, f, f, f, t] }, units)).toEqual({ kind: "fallback" });
    expect(classify({ inputErrors: [], results: [t, f, t, f, f] }, units)).toEqual({ kind: "mapped", unit: units[1] });
  });
  it("several matches are ambiguous, never masked by the fallback", () => {
    expect(classify({ inputErrors: [], results: [t, t, f, t, f] }, units)).toEqual({
      kind: "ambiguous",
      matches: [units[0], units[2]],
    });
  });
  it("an event outside the assumption isn't translated, even with no match", () => {
    expect(classify({ inputErrors: [], results: [f, f, f, f, t] }, units)).toEqual({ kind: "outside-domain", matches: [] });
    expect(classify({ inputErrors: [], results: [f, t, f, f, f] }, units)).toEqual({
      kind: "outside-domain",
      matches: [units[0]],
    });
  });
  it("an erroring unit makes the event an error, not the fallback", () => {
    const err = { ok: false as const, kind: "eval" as const, error: "/ by zero" };
    const c = classify({ inputErrors: [], results: [t, t, err, f, err] }, units);
    expect(c).toMatchObject({ kind: "unit-error", matches: [units[0]], errors: [{ unit: units[1] }] });
    expect(classify({ inputErrors: [], results: [t, f, err, f, err] }, units).kind).toBe("unit-error");
  });
  it("the runtime's fallback value must agree with the units'", () => {
    expect(classify({ inputErrors: [], results: [t, f, f, f, f] }, units).kind).toBe("fallback-error");
    expect(classify({ inputErrors: [], results: [t, f, f, f] }, units).kind).toBe("fallback-error");
  });
  it("input errors short-circuit", () => {
    const c = classify({ inputErrors: [{ field: "x", error: "missing value" }], results: [] }, units);
    expect(c.kind).toBe("input-error");
  });
});

describe("share links", () => {
  it("round-trip the configuration", () => {
    const w = workbenchFrom(unitExamples[0]);
    const back = decodeWorkbench(encodeWorkbench(w))!;
    expect(back.schema).toBe(w.schema);
    expect(back.units.map((u) => [u.name, u.predicate, u.symbol])).toEqual(
      w.units.map((u) => [u.name, u.predicate, u.symbol]),
    );
    expect(back.events.map((e) => e.values)).toEqual(w.events.map((e) => e.values));
    expect(back.fallback).toBe("other");
    expect(decodeWorkbench(encodeWorkbench({ ...w, fallback: "rest" }))!.fallback).toBe("rest");
  });
  it("links from before the fallback existed get the default", () => {
    const old = (o: object) => btoa(JSON.stringify(o));
    const base = { s: "x:int", a: "", e: [], t: 10, k: 5 };
    expect(decodeWorkbench(old({ ...base, u: [["a", "x == 1", "ev.a"]] }))!.fallback).toBe("other");
    expect(decodeWorkbench(old({ ...base, u: [["a", "x == 1", "other"]] }))!.fallback).toBe("other_2");
  });
  it("reject garbage", () => {
    expect(decodeWorkbench("not-base64!")).toBeNull();
    expect(decodeWorkbench(btoa("{}"))).toBeNull();
  });
});

describe("staleness", () => {
  it("any edit to a predicate changes the proof fingerprint", () => {
    const w = workbenchFrom(unitExamples[0]);
    const edited = { ...w, units: w.units.map((u, i) => (i === 0 ? { ...u, predicate: u.predicate + " " } : u)) };
    expect(proofFingerprint(edited)).not.toBe(proofFingerprint(w));
    expect(proofFingerprint({ ...w, events: [] })).toBe(proofFingerprint(w));
  });
  it("renaming the fallback changes both fingerprints", () => {
    const w = workbenchFrom(unitExamples[0]);
    expect(proofFingerprint({ ...w, fallback: "rest" })).not.toBe(proofFingerprint(w));
    expect(translationFingerprint({ ...w, fallback: "rest" })).not.toBe(translationFingerprint(w));
  });
});
