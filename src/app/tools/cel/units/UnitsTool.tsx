"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkSatisfiable,
  checkValid,
  compileOnly,
  EngineUnavailableError,
  evaluate,
  loadEngine,
  type LoadPhase,
  type VerifyOptions,
} from "@/lib/cel/engine";
import {
  assumptionOf,
  bindingsFor,
  classify,
  configIssues,
  decodeWorkbench,
  encodeWorkbench,
  evaluationExprs,
  exhaustiveQuery,
  FALLBACK_KEY,
  fallbackDisjointQuery,
  freshKey,
  gapQuery,
  isBoolType,
  pairQuery,
  parseSchema,
  proofFingerprint,
  reachQuery,
  readEmptiness,
  readValidity,
  translationFingerprint,
  type Classification,
  type ConcreteEvent,
  type ProofVerdict,
  type Unit,
  type Workbench,
} from "@/lib/cel/units";
import { unitExamples, workbenchFrom } from "@/lib/cel/unitExamples";

type Phase = LoadPhase | "proving" | "translating";

const phaseLabel: Record<Phase, string> = {
  z3: "loading z3 (~17 MB, cached)…",
  cheerpj: "starting the jvm…",
  jar: "loading the verifier (~9 MB, cached)…",
  proving: "proving…",
  translating: "evaluating…",
};

type Query = { query: string; verdict: ProofVerdict | null };

/**
 * The fallback's three questions. Runs on its own, debounced after every
 * relevant edit once the verifier is up, and as part of "prove".
 */
type CoverageRun = {
  fp: string;
  units: Unit[];
  fallback: string;
  /** Compile/type errors, per unit key; `""` for the assumption. */
  errors: Record<string, string>;
  domain: Query;
  /** isSatisfiable(A && fallback): does the fallback ever fire? */
  gap: Query;
  /** isSatisfiable(A && fallback && union): fallback against every explicit unit. */
  disjoint: Query;
  /** isAlwaysTrue(!A || union || fallback): is the translation total on the domain? */
  exhaustive: Query;
  done: boolean;
  fatal?: string;
};

type EngineState = "idle" | "loading" | "ready" | "failed";

/** Quiet period after an edit before coverage is re-checked. */
const COVERAGE_DEBOUNCE_MS = 700;

type ProofRun = {
  fp: string;
  units: Unit[];
  /** Compile/type errors, per unit key; `""` for the assumption. */
  errors: Record<string, string>;
  domain: Query;
  reach: Record<string, Query>;
  pairs: Record<string, Query>;
  done: boolean;
  /** Set when the engine itself couldn't run; nothing in this run is a result. */
  fatal?: string;
};

type TranslationRow = { event: ConcreteEvent; result: Classification | { kind: "engine-error"; error: string } };
type TranslationRun = {
  fp: string;
  rows: TranslationRow[];
  units: Unit[];
  fallback: string;
  done: boolean;
  fatal?: string;
};

const pairKey = (a: Unit, b: Unit) => `${a.key}|${b.key}`;

const DEFAULT = unitExamples[0];

let engineLoaded = false;

function describeEngineError(e: unknown): string {
  if (e instanceof EngineUnavailableError) return `couldn't load the verifier — ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function optionsFor(w: Workbench): VerifyOptions {
  return {
    variables: w.schema,
    unknowns: "",
    timeoutMs: Math.max(1, Math.round(w.timeoutSec * 1000)),
    unrollLimit: Math.max(0, Math.round(w.unroll)),
  };
}

/** Glyph + word for a cell; monochrome except overlaps and errors. */
function pairLook(
  v: ProofVerdict | null,
  diagonal: boolean,
  fallback = false,
): { glyph: string; word: string; tone: string } {
  if (v === null) return { glyph: "·", word: "pending", tone: "text-muted" };
  if (v.kind === "error") return { glyph: "!", word: "error", tone: "text-red-700" };
  if (v.kind === "not-proven") return { glyph: "?", word: "not proven", tone: "text-amber-700" };
  if (diagonal && fallback) {
    // An unreachable fallback isn't a bug: the explicit units already cover the domain.
    return v.kind === "refuted"
      ? { glyph: "◆", word: "reachable", tone: "text-foreground" }
      : { glyph: "∅", word: "unreachable", tone: "text-foreground" };
  }
  if (diagonal) {
    return v.kind === "refuted"
      ? { glyph: "◆", word: "reachable", tone: "text-foreground" }
      : { glyph: "∅", word: "vacuous", tone: "text-amber-700" };
  }
  return v.kind === "proved"
    ? { glyph: "⊥", word: "disjoint", tone: "text-foreground" }
    : { glyph: "∩", word: "overlap", tone: "text-red-700" };
}

export default function UnitsTool() {
  const [w, setW] = useState<Workbench>(() => workbenchFrom(DEFAULT));
  const [phase, setPhase] = useState<Phase | null>(null);
  const [proof, setProof] = useState<ProofRun | null>(null);
  const [translation, setTranslation] = useState<TranslationRun | null>(null);
  const [coverage, setCoverage] = useState<CoverageRun | null>(null);
  const [engine, setEngine] = useState<EngineState>(() => (engineLoaded ? "ready" : "idle"));
  const [engineError, setEngineError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const busy = useRef(false);
  /** Latest workbench, for the debounced coverage run. */
  const wRef = useRef(w);
  /** Bumped to start or cancel a coverage run; a run only publishes while it holds the latest value. */
  const coverageGen = useRef(0);
  /** Fingerprint the latest coverage run was started for. */
  const coverageFor = useRef<string | null>(null);

  useEffect(() => {
    wRef.current = w;
  }, [w]);

  useEffect(() => {
    const shared = new URLSearchParams(window.location.search).get("w");
    const decoded = shared ? decodeWorkbench(shared) : null;
    if (decoded) setW(decoded);
  }, []);

  const { fields, errors: schemaErrors } = useMemo(() => parseSchema(w.schema), [w.schema]);
  const issues = useMemo(() => configIssues(w), [w]);
  const blocking = issues.filter((i) => i.severity === "error");
  const proofFp = proofFingerprint(w);
  const translationFp = translationFingerprint(w);
  const proofStale = proof !== null && proof.fp !== proofFp;
  const translationStale = translation !== null && translation.fp !== translationFp;

  const update = (patch: Partial<Workbench>) => setW((prev) => ({ ...prev, ...patch }));
  const updateUnit = (key: string, patch: Partial<Unit>) =>
    setW((prev) => ({ ...prev, units: prev.units.map((u) => (u.key === key ? { ...u, ...patch } : u)) }));
  const updateEvent = (key: string, field: string, literal: string) =>
    setW((prev) => ({
      ...prev,
      events: prev.events.map((e) => (e.key === key ? { ...e, values: { ...e.values, [field]: literal } } : e)),
    }));

  async function ensureEngine() {
    if (!engineLoaded) {
      setEngine("loading");
      setEngineError(null);
      try {
        await loadEngine((p) => setPhase(p));
      } catch (e) {
        setEngine("failed");
        setEngineError(describeEngineError(e));
        throw e;
      }
      engineLoaded = true;
    }
    setEngine("ready");
  }

  /** Starts the verifier without waiting for a click, so coverage can be checked as soon as it's up. */
  function bootEngine() {
    if (busy.current) return;
    busy.current = true;
    ensureEngine()
      .catch(() => {})
      .finally(() => {
        setPhase(null);
        busy.current = false;
      });
  }

  useEffect(() => {
    bootEngine();
    // Once, on mount; loadEngine is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The fallback's coverage questions for one snapshot: compile everything,
   * then is the domain non-empty, does the fallback fire, is it disjoint
   * from the explicit units, and is the translation total. A newer run (or an
   * edit) bumps the generation; this one then stops asking and never
   * publishes again, so an old result can't land on edited input.
   */
  async function runCoverage(snapshot: Workbench) {
    const gen = ++coverageGen.current;
    const live = () => gen === coverageGen.current;
    const fp = proofFingerprint(snapshot);
    coverageFor.current = fp;
    const units = snapshot.units;
    const assumption = assumptionOf(snapshot);
    const options = optionsFor(snapshot);
    const run: CoverageRun = {
      fp,
      units,
      fallback: snapshot.fallback,
      errors: {},
      domain: { query: assumption, verdict: null },
      gap: { query: gapQuery(assumption, units), verdict: null },
      disjoint: { query: fallbackDisjointQuery(assumption, units), verdict: null },
      exhaustive: { query: exhaustiveQuery(assumption, units), verdict: null },
      done: false,
    };
    const queries = [run.gap, run.disjoint, run.exhaustive];
    const publish = () => {
      if (live()) setCoverage({ ...run, errors: { ...run.errors } });
    };
    publish();
    try {
      const sources: [string, string][] = [["", assumption], ...units.map((u) => [u.key, u.predicate] as [string, string])];
      for (const [key, src] of sources) {
        const c = await compileOnly(src, snapshot.schema);
        if (!live()) return;
        if (!c.ok) run.errors[key] = c.failure.kind === "compile" ? c.failure.error : c.failure.rootError;
        else if (!isBoolType(c.value.type)) run.errors[key] = `has type ${c.value.type}, not bool`;
      }
      const bad = Object.keys(run.errors);
      if (bad.length > 0) {
        const detail = bad
          .map((k) => `${k === "" ? "assumption" : units.find((u) => u.key === k)?.name}: ${run.errors[k]}`)
          .join("\n");
        if (run.errors[""] !== undefined) run.domain.verdict = { kind: "error", detail: run.errors[""] };
        for (const q of queries) q.verdict = { kind: "error", detail };
        return;
      }
      run.domain.verdict = readEmptiness(await checkSatisfiable(assumption, options));
      if (!live()) return;
      publish();
      if (run.domain.verdict.kind === "proved") {
        for (const q of queries) {
          q.verdict = { kind: "not-proven", detail: "not asked: the assumption is unsatisfiable, so any answer would be vacuous" };
        }
        return;
      }
      run.gap.verdict = readEmptiness(await checkSatisfiable(run.gap.query, options));
      if (!live()) return;
      publish();
      run.exhaustive.verdict = readValidity(await checkValid(run.exhaustive.query, options));
      if (!live()) return;
      publish();
      run.disjoint.verdict = readEmptiness(await checkSatisfiable(run.disjoint.query, options));
    } catch (e) {
      run.fatal = describeEngineError(e);
    } finally {
      run.done = true;
      publish();
    }
  }

  // Re-check coverage automatically: debounced after relevant edits, and as
  // soon as the verifier is up. Any edit cancels the run in flight; the
  // timer reads the latest workbench through wRef.
  useEffect(() => {
    if (coverageFor.current === proofFp) return;
    coverageGen.current++;
    coverageFor.current = null;
    if (engine !== "ready" || blocking.length > 0) return;
    const t = setTimeout(() => {
      // "prove" may have started this exact run meanwhile.
      if (coverageFor.current !== proofFingerprint(wRef.current)) void runCoverage(wRef.current);
    }, COVERAGE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [engine, proofFp, blocking.length]);

  async function prove() {
    if (busy.current || blocking.length > 0) return;
    busy.current = true;
    const snapshot = w;
    const units = snapshot.units;
    const assumption = assumptionOf(snapshot);
    const options = optionsFor(snapshot);
    const run: ProofRun = {
      fp: proofFingerprint(snapshot),
      units,
      errors: {},
      domain: { query: assumption, verdict: null },
      reach: Object.fromEntries(units.map((u) => [u.key, { query: reachQuery(assumption, u), verdict: null }])),
      pairs: {},
      done: false,
    };
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        run.pairs[pairKey(units[i], units[j])] = { query: pairQuery(assumption, units[i], units[j]), verdict: null };
      }
    }
    const publish = () => setProof({ ...run, reach: { ...run.reach }, pairs: { ...run.pairs }, errors: { ...run.errors } });
    setSelected(null);
    publish();
    try {
      await ensureEngine();
      setPhase("proving");
      // Coverage rides along (its queries interleave with the pairs below), unless it's already current.
      if (coverageFor.current !== run.fp) void runCoverage(snapshot);

      // Every source must compile against the shared schema and be a bool.
      const sources: [string, string][] = [["", assumption], ...units.map((u) => [u.key, u.predicate] as [string, string])];
      for (const [key, src] of sources) {
        const c = await compileOnly(src, snapshot.schema);
        if (!c.ok) run.errors[key] = c.failure.kind === "compile" ? c.failure.error : c.failure.rootError;
        else if (!isBoolType(c.value.type)) run.errors[key] = `has type ${c.value.type}, not bool`;
      }
      if (run.errors[""] !== undefined) {
        run.domain.verdict = { kind: "error", detail: run.errors[""] };
        for (const q of [...Object.values(run.reach), ...Object.values(run.pairs)]) {
          q.verdict = { kind: "error", detail: "the assumption doesn't compile" };
        }
        return;
      }
      for (const u of units) {
        if (run.errors[u.key] !== undefined) run.reach[u.key].verdict = { kind: "error", detail: run.errors[u.key] };
      }
      for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
          const bad = [units[i], units[j]].filter((u) => run.errors[u.key] !== undefined);
          if (bad.length) {
            run.pairs[pairKey(units[i], units[j])].verdict = {
              kind: "error",
              detail: bad.map((u) => `${u.name}: ${run.errors[u.key]}`).join("\n"),
            };
          }
        }
      }
      publish();

      run.domain.verdict = readEmptiness(await checkSatisfiable(assumption, options));
      publish();
      for (const u of units) {
        if (run.reach[u.key].verdict) continue;
        run.reach[u.key].verdict = readEmptiness(await checkSatisfiable(run.reach[u.key].query, options));
        publish();
      }
      for (const q of Object.values(run.pairs)) {
        if (q.verdict) continue;
        q.verdict = readEmptiness(await checkSatisfiable(q.query, options));
        publish();
      }
    } catch (e) {
      run.fatal = describeEngineError(e);
    } finally {
      run.done = true;
      publish();
      setPhase(null);
      busy.current = false;
    }
  }

  async function translate() {
    if (busy.current || blocking.length > 0) return;
    busy.current = true;
    const snapshot = w;
    const run: TranslationRun = {
      fp: translationFingerprint(snapshot),
      rows: [],
      units: snapshot.units,
      fallback: snapshot.fallback,
      done: false,
    };
    setTranslation({ ...run });
    try {
      await ensureEngine();
      setPhase("translating");
      const exprs = evaluationExprs(assumptionOf(snapshot), snapshot.units);
      for (const ev of snapshot.events) {
        const bindings = bindingsFor(fields, ev);
        const reserved = bindings.find((b) => /[\u001e\u001f]/.test(b.literal));
        let result: TranslationRow["result"];
        if (reserved) {
          result = { kind: "input-error", errors: [{ field: reserved.name, error: "reserved control character" }] };
        } else {
          const out = await evaluate(snapshot.schema, bindings, exprs);
          result = out.ok
            ? classify(out.value, snapshot.units)
            : { kind: "engine-error", error: out.failure.kind === "compile" ? out.failure.error : out.failure.rootError };
        }
        run.rows.push({ event: ev, result });
        setTranslation({ ...run, rows: [...run.rows] });
      }
    } catch (e) {
      run.fatal = describeEngineError(e);
    } finally {
      run.done = true;
      setTranslation({ ...run, rows: [...run.rows] });
      setPhase(null);
      busy.current = false;
    }
  }

  function loadWitness(witness: Record<string, string>) {
    const values: Record<string, string> = {};
    for (const f of fields) values[f.name] = witness[f.name] ?? "";
    setW((prev) => ({ ...prev, events: [...prev.events, { key: freshKey("e"), values }] }));
  }

  function applyExample(id: string) {
    const ex = unitExamples.find((e) => e.id === id);
    if (!ex) return;
    setW(workbenchFrom(ex));
    setProof(null);
    setTranslation(null);
    setCoverage(null);
    setSelected(null);
  }

  async function share() {
    const url = new URL(window.location.href);
    url.searchParams.set("w", encodeWorkbench(w));
    window.history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The address bar has the link either way.
    }
  }

  const pending = phase !== null;
  const area =
    "w-full resize-y border border-border bg-white/50 px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:border-muted transition-colors placeholder:text-muted/60";
  const input =
    "w-full border border-border bg-white/50 px-2 py-1 font-mono text-sm outline-none focus:border-muted transition-colors placeholder:text-muted/60";
  const label = "block font-mono text-xs tracking-wider text-muted";
  const button =
    "font-mono text-xs border border-border px-3 py-1.5 hover:border-muted hover:text-foreground text-muted transition-colors disabled:opacity-40 disabled:hover:border-border";
  const chip =
    "font-mono text-xs border border-border px-2 py-1 text-muted hover:border-muted hover:text-foreground transition-colors";
  const small = "font-mono text-xs text-muted hover:text-foreground transition-colors";

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      {/* Inputs */}
      <div className="flex-1 min-w-0 min-h-[50vh] lg:min-h-0 overflow-y-auto border-b lg:border-b-0 lg:border-r border-border">
        <div className="px-6 py-5 max-w-3xl">
          <p className="text-sm text-muted leading-relaxed">
            Each translation unit is a CEL predicate over one shared, typed event schema, naming the CSP event it maps
            to. The verifier proves that no event in the domain satisfies two units at once, and that every event in the
            domain lands somewhere — in one unit or the generated fallback — so the translation from concrete events to
            the CSP alphabet is a function. CEL&apos;s own runtime translates concrete events.
          </p>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="units-schema" className={label}>
                EVENT SCHEMA
              </label>
              <textarea
                id="units-schema"
                data-testid="units-schema"
                value={w.schema}
                onChange={(e) => update({ schema: e.target.value })}
                spellCheck={false}
                rows={4}
                className={`mt-2 ${area}`}
              />
              <p className="mt-1 font-mono text-xs text-muted">name:type — the variables of every query</p>
            </div>
            <div>
              <label htmlFor="units-assumption" className={label}>
                DOMAIN ASSUMPTION
              </label>
              <textarea
                id="units-assumption"
                data-testid="units-assumption"
                value={w.assumption}
                onChange={(e) => update({ assumption: e.target.value })}
                spellCheck={false}
                rows={4}
                placeholder="true"
                className={`mt-2 ${area}`}
              />
              <p className="mt-1 font-mono text-xs text-muted">CEL bool; conjoined into every proof</p>
            </div>
          </div>

          <div className="mt-6 flex items-baseline justify-between">
            <span className={label}>TRANSLATION UNITS</span>
            <button
              data-testid="units-add"
              onClick={() =>
                setW((prev) => ({
                  ...prev,
                  units: [...prev.units, { key: freshKey("u"), name: `unit_${prev.units.length + 1}`, predicate: "", symbol: "" }],
                }))
              }
              className={small}
            >
              + unit
            </button>
          </div>
          <ul className="mt-2 space-y-3">
            {w.units.map((u, i) => {
              const own = issues.filter((x) => x.unit === u.key);
              return (
                <li key={u.key} data-testid={`unit-${i}`} className="border border-border px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label="unit name"
                      value={u.name}
                      onChange={(e) => updateUnit(u.key, { name: e.target.value })}
                      spellCheck={false}
                      className={`${input} flex-1 min-w-[8rem]`}
                    />
                    <span className="font-mono text-xs text-muted">↦</span>
                    <input
                      aria-label="CSP event"
                      value={u.symbol}
                      onChange={(e) => updateUnit(u.key, { symbol: e.target.value })}
                      spellCheck={false}
                      placeholder="csp.event"
                      className={`${input} flex-1 min-w-[8rem]`}
                    />
                    <button
                      aria-label={`remove ${u.name}`}
                      onClick={() => setW((prev) => ({ ...prev, units: prev.units.filter((x) => x.key !== u.key) }))}
                      className={small}
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    aria-label={`predicate of ${u.name}`}
                    value={u.predicate}
                    onChange={(e) => updateUnit(u.key, { predicate: e.target.value })}
                    spellCheck={false}
                    rows={1}
                    placeholder="tool == 'read_file'"
                    className={`mt-2 ${area}`}
                  />
                  {own.map((x) => (
                    <p key={x.message} className="mt-1 font-mono text-xs text-red-700">
                      {x.message}
                    </p>
                  ))}
                </li>
              );
            })}
            <li data-testid="unit-fallback" className="border border-dashed border-border px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-1 min-w-[8rem] px-2 py-1 font-mono text-sm text-muted">otherwise</span>
                <span className="font-mono text-xs text-muted">↦</span>
                <input
                  aria-label="fallback CSP event"
                  value={w.fallback}
                  onChange={(e) => update({ fallback: e.target.value })}
                  spellCheck={false}
                  placeholder="other"
                  className={`${input} flex-1 min-w-[8rem]`}
                />
                <span className="w-[0.6rem]" />
              </div>
              <p className="mt-2 font-mono text-xs text-muted break-words">
                generated, not editable: !({w.units.map((u) => u.name || "?").join(" || ") || "false"}) — in-domain events no
                unit matches. Ambiguous events, errors and events outside the assumption never go here.
              </p>
              {issues
                .filter((x) => x.unit === FALLBACK_KEY)
                .map((x) => (
                  <p key={x.message} className="mt-1 font-mono text-xs text-red-700">
                    {x.message}
                  </p>
                ))}
            </li>
          </ul>

          {issues.filter((x) => x.unit === undefined).length > 0 && (
            <ul data-testid="units-issues" className="mt-3 space-y-1">
              {issues
                .filter((x) => x.unit === undefined)
                .map((x) => (
                  <li key={x.message} className={`font-mono text-xs ${x.severity === "error" ? "text-red-700" : "text-amber-700"}`}>
                    {x.severity === "error" ? "error" : "warning"}: {x.message}
                  </li>
                ))}
            </ul>
          )}

          <div className="mt-8 flex items-baseline justify-between">
            <span className={label}>CONCRETE EVENTS</span>
            <button
              data-testid="events-add"
              onClick={() =>
                setW((prev) => ({
                  ...prev,
                  events: [...prev.events, { key: freshKey("e"), values: Object.fromEntries(fields.map((f) => [f.name, ""])) }],
                }))
              }
              className={small}
            >
              + event
            </button>
          </div>
          <p className="mt-1 font-mono text-xs text-muted">
            one CEL literal per field, type-checked against the schema: &apos;read_file&apos;, 42, [&apos;pii&apos;]
          </p>
          {schemaErrors.length > 0 && (
            <p className="mt-2 font-mono text-xs text-red-700">fix the schema to edit events</p>
          )}
          <ul className="mt-2 space-y-2">
            {w.events.map((ev, i) => (
              <li key={ev.key} data-testid={`event-${i}`} className="flex flex-wrap items-end gap-2">
                <span className="font-mono text-xs text-muted w-6 pb-1.5">e{i + 1}</span>
                {fields.map((f) => (
                  <label key={f.name} className="flex-1 min-w-[7rem]">
                    <span className="font-mono text-[11px] text-muted">
                      {f.name}:{f.type}
                    </span>
                    <input
                      value={ev.values[f.name] ?? ""}
                      onChange={(e) => updateEvent(ev.key, f.name, e.target.value)}
                      spellCheck={false}
                      className={input}
                    />
                  </label>
                ))}
                <button
                  aria-label={`remove event ${i + 1}`}
                  onClick={() => setW((prev) => ({ ...prev, events: prev.events.filter((x) => x.key !== ev.key) }))}
                  className={`${small} pb-1.5`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button data-testid="units-prove" onClick={prove} disabled={pending || blocking.length > 0} className={button}>
              {phase && phase !== "translating" ? phaseLabel[phase] : "prove disjointness →"}
            </button>
            <button
              data-testid="units-translate"
              onClick={translate}
              disabled={pending || blocking.length > 0 || w.events.length === 0}
              className={button}
            >
              {phase === "translating" ? phaseLabel.translating : "translate events →"}
            </button>
            <button onClick={() => setShowOptions((v) => !v)} className={small}>
              {showOptions ? "− options" : "+ options"}
            </button>
            <button onClick={share} className={small}>
              {copied ? "link copied" : "share this workbench"}
            </button>
          </div>
          {blocking.length > 0 && (
            <p className="mt-2 font-mono text-xs text-red-700">fix the errors above to run anything</p>
          )}

          {showOptions && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="font-mono text-xs text-muted">
                timeout per query (s)
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={w.timeoutSec}
                  onChange={(e) => update({ timeoutSec: Number(e.target.value) })}
                  className={`mt-1 ${input}`}
                />
              </label>
              <label className="font-mono text-xs text-muted">
                comprehension unroll limit
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={w.unroll}
                  onChange={(e) => update({ unroll: Number(e.target.value) })}
                  className={`mt-1 ${input}`}
                />
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Side panel */}
      <div className="lg:w-[28rem] xl:w-[34rem] shrink-0 flex flex-col min-h-0 overflow-y-auto">
        <CoveragePanel
          coverage={coverage}
          stale={coverage !== null && coverage.fp !== proofFp}
          blocked={blocking.length > 0}
          engine={engine}
          engineError={engineError}
          onRetry={bootEngine}
          proof={proof && !proofStale && proof.done && !proof.fatal ? proof : null}
          selected={selected}
          onSelect={setSelected}
          onLoadWitness={loadWitness}
          fields={fields.map((f) => f.name)}
        />
        <ProofPanel
          proof={proof}
          coverage={coverage && coverage.fp === proof?.fp ? coverage : null}
          stale={proofStale}
          selected={selected}
          onSelect={setSelected}
          onLoadWitness={loadWitness}
          fields={fields.map((f) => f.name)}
          phase={phase}
        />
        <TranslationPanel translation={translation} stale={translationStale} fields={fields.map((f) => f.name)} />

        <div className="px-6 py-5 border-b border-border">
          <span className="font-mono text-xs tracking-wider text-muted">EXAMPLES</span>
          <div className="mt-3 flex flex-wrap gap-2">
            {unitExamples.map((ex) => (
              <button
                key={ex.id}
                data-testid={`units-example-${ex.id}`}
                title={ex.blurb}
                onClick={() => applyExample(ex.id)}
                className={chip}
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 py-5">
          <span className="font-mono text-xs tracking-wider text-muted">WHAT IS PROVEN</span>
          <div className="mt-3 text-xs text-muted leading-relaxed space-y-2">
            <p>
              For units P and Q the verifier is asked whether{" "}
              <code className="font-mono">(A) &amp;&amp; (P) &amp;&amp; (Q)</code> is satisfiable over the schema&apos;s
              variables, A being the domain assumption. <em>Not satisfiable</em> is a proof that no event in the
              domain is translated by both; <em>satisfiable</em> comes with a concrete witness; anything inconclusive
              (an approximated theory, a list longer than the unroll limit, a solver unknown or a timeout) is shown
              as not proven, never as disjoint. The diagonal asks the same of each unit alone: a unit no event can
              reach is vacuously disjoint from everything, which is usually a bug.
            </p>
            <p>
              Disjointness is about the predicates, not the output names: two units emitting the same CSP event still
              have to be disjoint here, and two units with different names can still overlap. With every pair
              disjoint, each in-domain event maps to at most one CSP event.
            </p>
            <p>
              The fallback is generated as <code className="font-mono">!(P1 || … || Pn)</code> and checked
              automatically after each edit: <code className="font-mono">isSatisfiable((A) &amp;&amp; fallback)</code>{" "}
              says whether the explicit units alone leave gaps (with an example event),{" "}
              <code className="font-mono">isAlwaysTrue(!(A) || P1 || … || Pn || fallback)</code> whether every
              in-domain event lands somewhere. That isn&apos;t a tautology in CEL: a predicate that errors (say{" "}
              <code className="font-mono">1000 / amount</code> at 0) is neither true nor false, the verifier reports
              the event as a counterexample, and the runtime reports it as an error rather than sending it to the
              fallback. Exhaustive says nothing about the explicit units overlapping each other — only together with
              every pair disjoint is each in-domain event mapped to exactly one CSP event. An unsatisfiable
              assumption makes all of this vacuous and is flagged. This is CEL analysed by Google&apos;s cel-java
              verifier and Z3; no CSP tool is looking at the CEL.
            </p>
            <p>
              Translating a concrete event doesn&apos;t use the solver: each field&apos;s literal is compiled against
              its declared type and every predicate is evaluated by cel-java&apos;s runtime, in the same environment
              the proofs compile in, and the runtime&apos;s value of the generated fallback has to agree. Events outside
              the assumption aren&apos;t translated — the proofs don&apos;t cover them.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

const FB = "(otherwise)";

const showWitness = (w: Record<string, string> | undefined) =>
  w && Object.keys(w).length > 0
    ? `{${Object.entries(w)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}}`
    : "an event";

type CoverageKey = "gap" | "exhaustive" | "disjoint";

/** One coverage answer in words; `glyph`/`tone` follow the matrix. */
function coverageLook(key: CoverageKey, v: ProofVerdict | null, fallback: string, domainNonEmpty: boolean) {
  if (v === null) return { glyph: "·", word: "pending", tone: "text-muted" };
  if (v.kind === "error") return { glyph: "!", word: "error — nothing proven", tone: "text-red-700" };
  if (v.kind === "not-proven") return { glyph: "?", word: "not proven", tone: "text-amber-700" };
  if (key === "gap") {
    return v.kind === "proved"
      ? { glyph: "∅", word: `cover the domain — ${fallback} never fires`, tone: "text-foreground" }
      : { glyph: "◆", word: `leave gaps — e.g. ${showWitness(v.witness)} goes to ${fallback}`, tone: "text-foreground" };
  }
  if (key === "exhaustive") {
    if (v.kind === "refuted") {
      return {
        glyph: "✕",
        word: `not exhaustive — on ${showWitness(v.witness)} neither a unit nor the fallback is true (a CEL error); the runtime reports it as an error`,
        tone: "text-red-700",
      };
    }
    return domainNonEmpty
      ? { glyph: "✓", word: "exhaustive — every in-domain event is matched by a unit or the fallback", tone: "text-foreground" }
      : { glyph: "✓", word: "exhaustive, but the domain wasn't shown non-empty", tone: "text-amber-700" };
  }
  return v.kind === "proved"
    ? { glyph: "⊥", word: "disjoint (by construction; checked)", tone: "text-foreground" }
    : { glyph: "∩", word: "overlap", tone: "text-red-700" };
}

function CoveragePanel({
  coverage,
  stale,
  blocked,
  engine,
  engineError,
  onRetry,
  proof,
  selected,
  onSelect,
  onLoadWitness,
  fields,
}: {
  coverage: CoverageRun | null;
  stale: boolean;
  blocked: boolean;
  engine: EngineState;
  engineError: string | null;
  onRetry: () => void;
  /** A finished, current pairwise run, if there is one. */
  proof: ProofRun | null;
  selected: string | null;
  onSelect: (k: string | null) => void;
  onLoadWitness: (w: Record<string, string>) => void;
  fields: string[];
}) {
  const c = coverage;
  const domainEmpty = c?.domain.verdict?.kind === "proved";
  const domainNonEmpty = c?.domain.verdict?.kind === "refuted";

  let status: { text: string; tone: string } | null = null;
  if (blocked) status = { text: "fix the errors above — nothing checked", tone: "text-red-700" };
  else if (engine === "failed") status = { text: `${engineError ?? "couldn't load the verifier"} — nothing proven`, tone: "text-red-700" };
  else if (engine !== "ready") status = { text: "loading the verifier — coverage is checked as soon as it's up", tone: "text-muted" };
  else if (c === null) status = { text: "checking shortly…", tone: "text-muted" };
  else if (stale) status = { text: "edited — re-checking automatically", tone: "text-amber-700" };
  else if (c.fatal) status = { text: `${c.fatal} — nothing proven`, tone: "text-red-700" };
  else if (!c.done) status = { text: "checking…", tone: "text-muted" };

  const rows: { key: CoverageKey; label: string; q: Query; method: "isSatisfiable" | "isAlwaysTrue" }[] = c
    ? [
        { key: "gap", label: "explicit units alone", q: c.gap, method: "isSatisfiable" },
        { key: "exhaustive", label: `with otherwise ↦ ${c.fallback}`, q: c.exhaustive, method: "isAlwaysTrue" },
        { key: "disjoint", label: "otherwise vs the units", q: c.disjoint, method: "isSatisfiable" },
      ]
    : [];

  let summary: string | null = null;
  if (c && c.done && !stale && !c.fatal && c.exhaustive.verdict?.kind === "proved" && domainNonEmpty) {
    const pairs = proof ? Object.values(proof.pairs) : null;
    if (pairs === null) {
      summary = "the translation is total on the domain; whether the explicit units overlap is the separate disjointness proof below";
    } else if (pairs.every((q) => q.verdict?.kind === "proved") && Object.keys(proof!.errors).length === 0) {
      summary = "total and unambiguous: every in-domain event is translated to exactly one CSP event";
    } else {
      summary = "total, but not every pair of units is proven disjoint — an in-domain event can still be ambiguous";
    }
  }

  const open = rows.find((r) => selected === `cov:${r.key}`);
  const fallbackName = c?.fallback ?? "";

  return (
    <div className="px-6 py-5 border-b border-border" data-testid="units-coverage">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-xs tracking-wider text-muted">COVERAGE</span>
        <span className="font-mono text-[11px] text-muted">automatic</span>
      </div>
      {status && (
        <p data-testid="units-coverage-status" className={`mt-3 font-mono text-xs ${status.tone}`}>
          {status.text}
          {engine === "failed" && !blocked && (
            <button onClick={onRetry} className="ml-2 underline hover:text-foreground">
              retry
            </button>
          )}
        </p>
      )}
      {c && (
        <div className={`mt-3 ${stale ? "opacity-50" : ""}`}>
          {domainEmpty && (
            <p data-testid="units-coverage-vacuous" className="mb-2 font-mono text-xs text-amber-700">
              the assumption is unsatisfiable — any coverage claim would be vacuous; nothing useful is proven
            </p>
          )}
          <ul className="space-y-1.5">
            {rows.map((r) => {
              const look = coverageLook(r.key, r.q.verdict, fallbackName, domainNonEmpty);
              return (
                <li key={r.key}>
                  <button
                    data-testid={`coverage-${r.key}`}
                    data-verdict={r.q.verdict?.kind ?? "pending"}
                    onClick={() => onSelect(selected === `cov:${r.key}` ? null : `cov:${r.key}`)}
                    className={`text-left font-mono text-xs ${selected === `cov:${r.key}` ? "underline" : ""}`}
                  >
                    <span className="text-muted">{r.label}: </span>
                    <span className={look.tone}>
                      {look.glyph} {look.word}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {summary && (
            <p data-testid="units-coverage-summary" className="mt-3 font-mono text-xs">
              {summary}
            </p>
          )}
          {open && (
            <QueryDetail
              title={open.label}
              q={open.q}
              diagonal={false}
              method={open.method}
              words={coverageLook(open.key, open.q.verdict, fallbackName, domainNonEmpty)}
              fields={fields}
              onLoadWitness={onLoadWitness}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ProofPanel({
  proof,
  coverage,
  stale,
  selected,
  onSelect,
  onLoadWitness,
  fields,
  phase,
}: {
  proof: ProofRun | null;
  /** The coverage run for the same inputs, if any: it supplies the fallback's row. */
  coverage: CoverageRun | null;
  stale: boolean;
  selected: string | null;
  onSelect: (k: string | null) => void;
  onLoadWitness: (w: Record<string, string>) => void;
  fields: string[];
  phase: Phase | null;
}) {
  const units = proof?.units ?? [];
  const cell = (i: number, j: number): Query | undefined => {
    if (!proof) return undefined;
    if (i === j) return proof.reach[units[i].key];
    const [a, b] = i < j ? [units[i], units[j]] : [units[j], units[i]];
    return proof.pairs[pairKey(a, b)];
  };
  const cellKey = (i: number, j: number) => (i === j ? `r:${units[i].key}` : `p:${Math.min(i, j)}:${Math.max(i, j)}`);
  const pairs = proof ? Object.values(proof.pairs) : [];
  const count = (k: ProofVerdict["kind"]) => pairs.filter((q) => q.verdict?.kind === k).length;
  const vacuous = proof ? units.filter((u) => proof.reach[u.key]?.verdict?.kind === "proved") : [];
  const domainEmpty = proof?.domain.verdict?.kind === "proved";

  let summary: string | null = null;
  if (proof && proof.done && !stale) {
    const errors = count("error") + Object.keys(proof.errors).length;
    if (proof.fatal) summary = "verifier unavailable — nothing was proven";
    else if (proof.errors[""] !== undefined) summary = "the assumption doesn't compile — nothing was proven";
    else if (domainEmpty) summary = "the assumption is unsatisfiable: every pair is vacuously disjoint, which proves nothing";
    else if (errors > 0) summary = `not proven: ${errors} error(s)`;
    else if (pairs.length === 0) summary = "one unit: nothing to compare";
    else if (count("proved") === pairs.length) {
      summary = `all ${pairs.length} pairs proven disjoint under the assumption`;
    } else {
      summary = `${count("refuted")} overlapping, ${count("not-proven")} not proven, ${count("proved")} of ${pairs.length} pairs proven disjoint`;
    }
  }

  const fbDisjoint = coverage?.disjoint ?? null;
  const fbGap = coverage?.gap ?? null;

  let detail: { title: string; q: Query; diagonal: boolean; fallback?: boolean } | null = null;
  if (proof && selected) {
    if (selected === "domain") detail = { title: "domain assumption", q: proof.domain, diagonal: true };
    if (selected === "f:disjoint" && fbDisjoint) {
      detail = { title: "otherwise ∧ (any unit)", q: fbDisjoint, diagonal: false };
    }
    if (selected === "f:gap" && fbGap) detail = { title: "otherwise alone", q: fbGap, diagonal: true, fallback: true };
    for (let i = 0; i < units.length && !detail; i++) {
      for (let j = i; j < units.length && !detail; j++) {
        if (cellKey(i, j) === selected) {
          detail = {
            title: i === j ? `${units[i].name} alone` : `${units[i].name} ∧ ${units[j].name}`,
            q: cell(i, j)!,
            diagonal: i === j,
          };
        }
      }
    }
  }

  return (
    <div className="px-6 py-5 border-b border-border" data-testid="units-proof">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-xs tracking-wider text-muted">DISJOINTNESS</span>
        {phase && <span className="font-mono text-xs text-muted">{phaseLabel[phase]}</span>}
      </div>
      {proof === null ? (
        <p className="mt-3 font-mono text-sm text-muted">nothing proven yet</p>
      ) : (
        <div className={`mt-3 ${stale ? "opacity-50" : ""}`}>
          {stale && (
            <p data-testid="units-proof-stale" className="mb-2 font-mono text-xs text-amber-700">
              edited since this run — these results are stale; prove again
            </p>
          )}
          {summary && (
            <p data-testid="units-proof-summary" className="mb-3 font-mono text-xs">
              {summary}
            </p>
          )}
          {vacuous.length > 0 && !stale && (
            <p className="mb-3 font-mono text-xs text-amber-700">
              vacuous (no event in the domain reaches it): {vacuous.map((u) => u.name).join(", ")}
            </p>
          )}
          {proof.domain.verdict && (
            <button
              onClick={() => onSelect("domain")}
              className="mb-2 font-mono text-xs text-muted hover:text-foreground"
            >
              domain:{" "}
              {proof.domain.verdict.kind === "refuted"
                ? "non-empty"
                : proof.domain.verdict.kind === "proved"
                  ? "EMPTY"
                  : proof.domain.verdict.kind}
            </button>
          )}
          <div className="overflow-x-auto">
            <table data-testid="units-matrix" className="font-mono text-xs border-collapse">
              <thead>
                <tr>
                  <th />
                  {units.map((u, j) => (
                    <th key={u.key} className="px-1 pb-1 text-muted font-normal" title={u.name}>
                      {j + 1}
                    </th>
                  ))}
                  <th className="px-1 pb-1 text-muted font-normal" title="otherwise (generated fallback)">
                    {units.length + 1}
                  </th>
                </tr>
              </thead>
              <tbody>
                {units.map((u, i) => (
                  <tr key={u.key}>
                    <th className="pr-2 text-left text-muted font-normal whitespace-nowrap">
                      {i + 1} {u.name}
                    </th>
                    {units.map((v, j) => {
                      const look = pairLook(cell(i, j)?.verdict ?? null, i === j);
                      const k = cellKey(i, j);
                      return (
                        <td key={v.key} className="p-0">
                          <button
                            data-testid={`cell-${u.name}-${v.name}`}
                            data-verdict={look.word}
                            title={`${i === j ? u.name : `${u.name} ∧ ${v.name}`}: ${look.word}`}
                            onClick={() => onSelect(selected === k ? null : k)}
                            className={`w-7 h-7 border ${selected === k ? "border-foreground" : "border-border"} ${look.tone} ${i === j ? "bg-black/[0.03]" : ""}`}
                          >
                            {look.glyph}
                          </button>
                        </td>
                      );
                    })}
                    <FallbackCell
                      testId={`cell-${u.name}-${FB}`}
                      title={`${u.name} ∧ otherwise`}
                      q={fbDisjoint}
                      selKey="f:disjoint"
                      selected={selected}
                      onSelect={onSelect}
                    />
                  </tr>
                ))}
                <tr>
                  <th className="pr-2 text-left text-muted font-normal whitespace-nowrap">
                    {units.length + 1} otherwise
                  </th>
                  {units.map((v) => (
                    <FallbackCell
                      key={v.key}
                      testId={`cell-${FB}-${v.name}`}
                      title={`otherwise ∧ ${v.name}`}
                      q={fbDisjoint}
                      selKey="f:disjoint"
                      selected={selected}
                      onSelect={onSelect}
                    />
                  ))}
                  <FallbackCell
                    testId={`cell-${FB}-${FB}`}
                    title="otherwise alone"
                    q={fbGap}
                    selKey="f:gap"
                    selected={selected}
                    onSelect={onSelect}
                    diagonal
                  />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 font-mono text-[11px] text-muted">
            ⊥ disjoint (proved) · ∩ overlap (witness) · ? not proven · ! error · diagonal: ◆ reachable, ∅ vacuous ·
            otherwise: the generated fallback, checked against all units in one query (from the coverage check)
          </p>
          {detail && (
            <QueryDetail {...detail} method="isSatisfiable" fields={fields} onLoadWitness={onLoadWitness} />
          )}
          {proof.fatal && <p className="mt-3 font-mono text-xs text-red-700">{proof.fatal}</p>}
        </div>
      )}
    </div>
  );
}

function FallbackCell({
  testId,
  title,
  q,
  selKey,
  selected,
  onSelect,
  diagonal = false,
}: {
  testId: string;
  title: string;
  q: Query | null;
  selKey: string;
  selected: string | null;
  onSelect: (k: string | null) => void;
  diagonal?: boolean;
}) {
  const look = pairLook(q?.verdict ?? null, diagonal, true);
  return (
    <td className="p-0">
      <button
        data-testid={testId}
        data-verdict={look.word}
        title={`${title}: ${look.word}`}
        disabled={q === null}
        onClick={() => onSelect(selected === selKey ? null : selKey)}
        className={`w-7 h-7 border border-dashed ${selected === selKey ? "border-foreground" : "border-border"} ${look.tone} ${diagonal ? "bg-black/[0.03]" : ""}`}
      >
        {look.glyph}
      </button>
    </td>
  );
}

function QueryDetail({
  title,
  q,
  diagonal,
  fallback = false,
  method,
  words,
  fields,
  onLoadWitness,
}: {
  title: string;
  q: Query;
  diagonal: boolean;
  fallback?: boolean;
  method: "isSatisfiable" | "isAlwaysTrue";
  /** Overrides the cell wording, for the coverage questions. */
  words?: { glyph: string; word: string; tone: string };
  fields: string[];
  onLoadWitness: (w: Record<string, string>) => void;
}) {
  const v = q.verdict;
  const look = words ?? pairLook(v, diagonal, fallback);
  const witness = v && (v.kind === "refuted" || v.kind === "not-proven") ? v.witness : undefined;
  return (
    <div data-testid="units-detail" className="mt-4 border-t border-border pt-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-xs">{title}</span>
        <span className={`font-mono text-xs ${look.tone}`}>
          {look.glyph} {look.word}
        </span>
      </div>
      <span className="mt-3 block font-mono text-[11px] tracking-wider text-muted">{method}</span>
      <pre className="mt-1 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{q.query}</pre>
      {v && (
        <>
          <span className="mt-3 block font-mono text-[11px] tracking-wider text-muted">VERIFIER SAID</span>
          <pre className="mt-1 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{v.detail}</pre>
        </>
      )}
      {witness && Object.keys(witness).length > 0 && (
        <button
          data-testid="units-load-witness"
          onClick={() => onLoadWitness(witness)}
          className="mt-3 font-mono text-xs border border-border px-2 py-1 text-muted hover:border-muted hover:text-foreground"
        >
          add {method === "isAlwaysTrue" ? "counterexample" : "witness"} as a concrete event
        </button>
      )}
      {witness && Object.keys(witness).length > 0 && fields.some((f) => !(f in witness)) && (
        <p className="mt-2 font-mono text-xs text-muted">
          free in the witness (the query doesn&apos;t constrain them; fill in any value):{" "}
          {fields.filter((f) => !(f in witness)).join(", ")}
        </p>
      )}
    </div>
  );
}

function TranslationPanel({
  translation,
  stale,
  fields,
}: {
  translation: TranslationRun | null;
  stale: boolean;
  fields: string[];
}) {
  const rows = translation?.rows ?? [];
  const trace: string[] = [];
  let traceBroken: string | null = null;
  rows.forEach((r, i) => {
    if (r.result.kind === "mapped") trace.push(r.result.unit.symbol);
    else if (r.result.kind === "fallback") trace.push(translation!.fallback);
    else if (traceBroken === null) {
      traceBroken = `e${i + 1} is ${
        r.result.kind === "ambiguous" ? "ambiguous" : r.result.kind === "outside-domain" ? "outside the domain" : "an error"
      }`;
    }
  });

  return (
    <div className="px-6 py-5 border-b border-border" data-testid="units-translation">
      <span className="font-mono text-xs tracking-wider text-muted">TRANSLATION</span>
      {translation === null ? (
        <p className="mt-3 font-mono text-sm text-muted">nothing translated yet</p>
      ) : (
        <div className={`mt-3 ${stale ? "opacity-50" : ""}`}>
          {stale && (
            <p data-testid="units-translation-stale" className="mb-2 font-mono text-xs text-amber-700">
              edited since this run — stale; translate again
            </p>
          )}
          <ol className="space-y-3">
            {rows.map((r, i) => (
              <li key={r.event.key} data-testid={`translation-${i}`} className="font-mono text-xs">
                <div className="text-muted break-words">
                  e{i + 1} {"{"}
                  {fields.map((f) => `${f}: ${r.event.values[f] ?? ""}`).join(", ")}
                  {"}"}
                </div>
                <div className="mt-0.5">
                  <ClassificationLine c={r.result} fallback={translation.fallback} />
                </div>
              </li>
            ))}
          </ol>
          {translation.fatal && <p className="mt-3 font-mono text-xs text-red-700">{translation.fatal}</p>}
          {translation.done && !translation.fatal && rows.length > 0 && (
            <p data-testid="units-trace" className="mt-4 font-mono text-xs break-words">
              {traceBroken ? `no CSP trace: ${traceBroken}` : `CSP trace ⟨${trace.join(", ")}⟩`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ClassificationLine({ c, fallback }: { c: TranslationRow["result"]; fallback: string }) {
  const domain = (inDomain: boolean) =>
    inDomain ? null : <span className="text-amber-700"> · outside the assumption — not covered by the proofs</span>;
  switch (c.kind) {
    case "engine-error":
      return <span className="text-red-700">! verifier error: {c.error}</span>;
    case "input-error":
      return (
        <span className="text-red-700">
          ! bad input: {c.errors.map((e) => `${e.field}: ${e.error}`).join("; ")}
        </span>
      );
    case "assumption-error":
      return <span className="text-red-700">! assumption: {c.error}</span>;
    case "unit-error":
      return (
        <span className="text-red-700">
          ! {c.errors.map((e) => `${e.unit.name}: ${e.error}`).join("; ")}
          {c.matches.length > 0 && <span className="text-muted"> (also matched: {c.matches.map((u) => u.name).join(", ")})</span>}
          {domain(c.inDomain)}
        </span>
      );
    case "fallback-error":
      return <span className="text-red-700">! fallback disagrees with the units: {c.error}</span>;
    case "outside-domain":
      return (
        <span className="text-amber-700">
          ⊘ outside the assumption — not translated
          {c.matches.length > 0 && <span className="text-muted"> (would match: {c.matches.map((u) => u.name).join(", ")})</span>}
        </span>
      );
    case "fallback":
      return (
        <span>
          <span className="text-muted">→ no unit matches → otherwise →</span>{" "}
          <strong className="font-semibold">{fallback}</strong>
        </span>
      );
    case "mapped":
      return (
        <span>
          → {c.unit.name} → <strong className="font-semibold">{c.unit.symbol}</strong>
        </span>
      );
    case "ambiguous":
      return (
        <span className="text-red-700">
          ∩ ambiguous: {c.matches.map((u) => `${u.name} → ${u.symbol}`).join(", ")} (not sent to the fallback)
        </span>
      );
  }
}
