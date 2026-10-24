/**
 * Translation units: CEL predicates that map concrete events onto abstract
 * CSP events, and the formal questions asked about them.
 *
 * Nothing here decides anything. Classification of a concrete event comes
 * from cel-java's runtime (`evaluate` in engine.ts); disjointness and
 * reachability come from the cel-java verifier's `isSatisfiable`. This module
 * only builds the queries, reads the verifier's statuses back, and validates
 * the configuration around them.
 */

import type { Evaluation, EvaluationBatch, Outcome, VerificationResult } from "./engine";

export type Unit = {
  /** Local identity for React keys and result bookkeeping; never shown. */
  key: string;
  /** Stable, user-facing unit name. */
  name: string;
  /** CEL boolean predicate over the shared schema. */
  predicate: string;
  /** The abstract CSP event the unit maps to. */
  symbol: string;
};

/** A concrete event: one CEL literal per schema field, keyed by field name. */
export type ConcreteEvent = { key: string; values: Record<string, string> };

export type Workbench = {
  /** `name:type`, one per line — the verifier's own variable syntax. */
  schema: string;
  /** Domain assumption shared by every proof and checked on every event. */
  assumption: string;
  units: Unit[];
  events: ConcreteEvent[];
  timeoutSec: number;
  unroll: number;
};

export type Field = { name: string; type: string };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A fixed CSP event name: dotted identifiers, as in `call.read` or `deny`. */
const CSP_SYMBOL = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
/** Separators the bridge uses between bindings and expressions. */
const RESERVED = /[\u001e\u001f]/;

/**
 * Field names and types, read the way CelVerifierWeb reads them (one
 * `name:type` per line, `//` and `#` lines ignored). Only used to lay out the
 * event form; the Java side parses the same text and is authoritative.
 */
export function parseSchema(schema: string): { fields: Field[]; errors: string[] } {
  const fields: Field[] = [];
  const errors: string[] = [];
  for (const raw of schema.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    const name = i < 0 ? line : line.slice(0, i).trim();
    const type = i < 0 ? "" : line.slice(i + 1).trim();
    if (!IDENT.test(name)) errors.push(`"${line}": field name must be an identifier`);
    else if (type === "") errors.push(`"${line}": expected name:type`);
    else if (fields.some((f) => f.name === name)) errors.push(`field ${name} declared twice`);
    else fields.push({ name, type });
  }
  if (fields.length === 0 && errors.length === 0) errors.push("declare at least one field");
  return { fields, errors };
}

export type ConfigIssue = { unit?: string; severity: "error" | "warning"; message: string };

/** Problems with the unit table itself, before any solver is involved. */
export function configIssues(w: Pick<Workbench, "schema" | "assumption" | "units">): ConfigIssue[] {
  const issues: ConfigIssue[] = parseSchema(w.schema).errors.map((message) => ({
    severity: "error" as const,
    message: `schema: ${message}`,
  }));
  if (RESERVED.test(w.schema) || RESERVED.test(w.assumption)) {
    issues.push({ severity: "error", message: "schema/assumption contain reserved control characters" });
  }
  if (w.units.length === 0) issues.push({ severity: "error", message: "add at least one translation unit" });

  const byName = new Map<string, number>();
  const bySymbol = new Map<string, string[]>();
  for (const u of w.units) {
    const label = u.name || "(unnamed)";
    if (!IDENT.test(u.name)) {
      issues.push({ unit: u.key, severity: "error", message: `unit ${label}: name must be an identifier` });
    }
    byName.set(u.name, (byName.get(u.name) ?? 0) + 1);
    if (!CSP_SYMBOL.test(u.symbol)) {
      issues.push({
        unit: u.key,
        severity: "error",
        message: `unit ${label}: CSP event must be a fixed name like call.read`,
      });
    } else {
      bySymbol.set(u.symbol, [...(bySymbol.get(u.symbol) ?? []), label]);
    }
    if (u.predicate.trim() === "") {
      issues.push({ unit: u.key, severity: "error", message: `unit ${label}: empty predicate` });
    }
    if (RESERVED.test(u.predicate)) {
      issues.push({ unit: u.key, severity: "error", message: `unit ${label}: reserved control characters` });
    }
  }
  for (const [name, n] of byName) {
    if (n > 1 && name !== "") {
      issues.push({ severity: "error", message: `unit name ${name} is used ${n} times; names must be unique` });
    }
  }
  for (const [symbol, names] of bySymbol) {
    if (names.length > 1) {
      issues.push({
        severity: "warning",
        message: `${names.join(", ")} all emit ${symbol}: the proofs below are about the predicates, so these are still checked pairwise, but the alphabet merges them`,
      });
    }
  }
  return issues;
}

/** Conjunction of CEL sources, each kept intact on its own lines (so `//` comments stay comments). */
export function conjoin(...exprs: string[]): string {
  return exprs.map((e) => `(\n${e.trim() === "" ? "true" : e}\n)`).join(" && ");
}

export const assumptionOf = (w: Pick<Workbench, "assumption">) =>
  w.assumption.trim() === "" ? "true" : w.assumption;

/** `isSatisfiable` of the pair under the shared assumption: the disjointness query. */
export const pairQuery = (assumption: string, a: Unit, b: Unit) =>
  conjoin(assumption, a.predicate, b.predicate);

/** `isSatisfiable` of a unit under the assumption: does the unit ever fire? */
export const reachQuery = (assumption: string, u: Unit) => conjoin(assumption, u.predicate);

/** cel-java's compile() reports the AST's result type; for bool that's `SimpleType{kind=BOOL, name=bool}`. */
export const isBoolType = (t: string) => t === "bool" || /\bkind=BOOL\b/.test(t);

export type ProofVerdict =
  | { kind: "proved"; detail: string }
  | { kind: "refuted"; detail: string; witness: Record<string, string> }
  | { kind: "not-proven"; detail: string; witness?: Record<string, string> }
  | { kind: "error"; detail: string };

/**
 * Reads `isSatisfiable(q)` back as an answer to "is q empty?".
 *
 * cel-java maps an exact Z3 model to VERIFIED ("Condition is satisfiable",
 * with the model in `reason`), no model in any of its three passes (exact,
 * approximate, beyond the unroll bound) to VIOLATED, and everything else —
 * a model that depends on approximations, a bounded search that was cut off,
 * a solver `unknown` — to INCONCLUSIVE. A timeout throws, which arrives here
 * as a runtime failure. Only VIOLATED proves emptiness.
 */
export function readEmptiness(out: Outcome<VerificationResult>): ProofVerdict {
  if (!out.ok) {
    const f = out.failure;
    return { kind: "error", detail: f.kind === "compile" ? f.error : f.rootError || f.error };
  }
  const r = out.value;
  if (r.status === "VIOLATED") return { kind: "proved", detail: r.message };
  if (r.status === "VERIFIED") return { kind: "refuted", detail: r.message, witness: parseWitness(r.message) };
  const witness = parseWitness(r.message);
  return { kind: "not-proven", detail: r.message, ...(Object.keys(witness).length ? { witness } : {}) };
}

/**
 * The model cel-java prints after "Satisfying input:" — one `  name = value`
 * line per constant — turned back into CEL literals where that's unambiguous
 * (Z3 strings and negative numerals are rewritten). Fields the solver left
 * unconstrained don't appear. A convenience for loading a witness as a
 * concrete event; the event then goes through the real CEL runtime.
 */
export function parseWitness(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  const at = message.search(/(Satisfying|Counterexample) input:/);
  if (at < 0) return out;
  for (const line of message.slice(at).split("\n").slice(1)) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*) = (.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = z3ToCel(m[2]);
  }
  return out;
}

function z3ToCel(v: string): string {
  const neg = /^\(- (\d+(?:\.\d+)?)\)(u?)$/.exec(v);
  if (neg) return `-${neg[1]}${neg[2]}`;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    const body = v
      .slice(1, -1)
      .replace(/""/g, '"')
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
    return JSON.stringify(body);
  }
  return v;
}

export type Classification =
  | { kind: "input-error"; errors: { field: string; error: string }[] }
  | { kind: "assumption-error"; error: string }
  | { kind: "unit-error"; errors: { unit: Unit; error: string }[]; matches: Unit[]; inDomain: boolean }
  | { kind: "unmapped"; inDomain: boolean }
  | { kind: "mapped"; unit: Unit; inDomain: boolean }
  | { kind: "ambiguous"; matches: Unit[]; inDomain: boolean };

/** Bindings for `evaluate`: every schema field, in schema order, as typed. */
export function bindingsFor(fields: Field[], ev: ConcreteEvent): { name: string; literal: string }[] {
  return fields.map((f) => ({ name: f.name, literal: ev.values[f.name] ?? "" }));
}

/** Expressions for `evaluate`: the assumption first, then each unit's predicate. */
export const evaluationExprs = (assumption: string, units: Unit[]) => [assumption, ...units.map((u) => u.predicate)];

/**
 * Turns the runtime's per-expression results into a translation. No first
 * match wins: zero matches is unmapped, several is ambiguous, and a unit
 * whose predicate didn't evaluate to a bool makes the whole event an error.
 */
export function classify(batch: EvaluationBatch, units: Unit[]): Classification {
  if (batch.inputErrors.length > 0) return { kind: "input-error", errors: batch.inputErrors };
  const [assumption, ...rest] = batch.results;
  if (!assumption?.ok) {
    return { kind: "assumption-error", error: assumption ? assumption.error : "no result for the assumption" };
  }
  const inDomain = assumption.value;
  const errors: { unit: Unit; error: string }[] = [];
  const matches: Unit[] = [];
  units.forEach((u, i) => {
    const r: Evaluation | undefined = rest[i];
    if (!r) errors.push({ unit: u, error: "no result" });
    else if (!r.ok) errors.push({ unit: u, error: `${r.kind}: ${r.error}` });
    else if (r.value) matches.push(u);
  });
  if (errors.length > 0) return { kind: "unit-error", errors, matches, inDomain };
  if (matches.length === 0) return { kind: "unmapped", inDomain };
  if (matches.length === 1) return { kind: "mapped", unit: matches[0], inDomain };
  return { kind: "ambiguous", matches, inDomain };
}

/** What a proof run was about; any difference makes its results stale. */
export function proofFingerprint(w: Workbench): string {
  return JSON.stringify([
    w.schema,
    w.assumption,
    w.units.map((u) => [u.key, u.name, u.predicate, u.symbol]),
    w.timeoutSec,
    w.unroll,
  ]);
}

/** What a translation run was about. */
export function translationFingerprint(w: Workbench): string {
  return JSON.stringify([
    w.schema,
    w.assumption,
    w.units.map((u) => [u.key, u.name, u.predicate, u.symbol]),
    w.events.map((e) => [e.key, e.values]),
  ]);
}

let counter = 0;
export const freshKey = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

type Shared = { s: string; a: string; u: [string, string, string][]; e: Record<string, string>[]; t: number; k: number };

/** Base64url of UTF-8 JSON, the same scheme the other tools' share links use. */
export function encodeWorkbench(w: Workbench): string {
  const shared: Shared = {
    s: w.schema,
    a: w.assumption,
    u: w.units.map((u) => [u.name, u.predicate, u.symbol]),
    e: w.events.map((e) => e.values),
    t: w.timeoutSec,
    k: w.unroll,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(shared));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeWorkbench(param: string): Workbench | null {
  try {
    const bin = atob(param.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const s = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Shared>;
    if (typeof s.s !== "string" || typeof s.a !== "string" || !Array.isArray(s.u) || !Array.isArray(s.e)) return null;
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    return {
      schema: s.s,
      assumption: s.a,
      units: s.u.map((u) => ({
        key: freshKey("u"),
        name: str(u?.[0]),
        predicate: str(u?.[1]),
        symbol: str(u?.[2]),
      })),
      events: s.e.map((values) => ({
        key: freshKey("e"),
        values: Object.fromEntries(
          Object.entries(values && typeof values === "object" ? values : {}).map(([k, v]) => [k, str(v)]),
        ),
      })),
      timeoutSec: typeof s.t === "number" && s.t > 0 ? s.t : 10,
      unroll: typeof s.k === "number" && s.k >= 0 ? s.k : 5,
    };
  } catch {
    return null;
  }
}
