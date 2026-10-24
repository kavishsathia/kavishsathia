import { describe, expect, it } from "vitest";
import {
  classify,
  configIssues,
  conjoin,
  decodeWorkbench,
  encodeWorkbench,
  pairQuery,
  parseSchema,
  parseWitness,
  proofFingerprint,
  readEmptiness,
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
    });
    expect(issues.some((i) => i.severity === "error" && /used 2 times/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.severity === "warning" && /emit ev/.test(i.message))).toBe(true);
  });
  it("requires fixed CSP event names", () => {
    const issues = configIssues({ schema: "x:int", assumption: "", units: [unit("a", "x == 1", "ev?x")] });
    expect(issues.map((i) => i.message).join()).toMatch(/fixed name/);
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

  it("zero, one and several matches", () => {
    expect(classify({ inputErrors: [], results: [t, f, f, f] }, units)).toEqual({ kind: "unmapped", inDomain: true });
    expect(classify({ inputErrors: [], results: [t, f, t, f] }, units)).toMatchObject({ kind: "mapped", unit: units[1] });
    expect(classify({ inputErrors: [], results: [f, t, f, t] }, units)).toMatchObject({
      kind: "ambiguous",
      matches: [units[0], units[2]],
      inDomain: false,
    });
  });
  it("an erroring unit makes the event an error, not a silent non-match", () => {
    const c = classify(
      { inputErrors: [], results: [t, t, { ok: false, kind: "eval", error: "/ by zero" }, f] },
      units,
    );
    expect(c).toMatchObject({ kind: "unit-error", matches: [units[0]], errors: [{ unit: units[1] }] });
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
});
