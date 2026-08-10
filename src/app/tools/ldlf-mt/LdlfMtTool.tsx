"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import {
  EngineUnavailableError,
  preload,
  toMermaid,
} from "@/lib/ldlf/engine";
import { enumerateTraces } from "@/lib/ldlf/traces";
import { translateMt, type MtResult } from "@/lib/ldlf-mt/translate";
import { loadZ3, SolverUnavailableError, type Z3Api } from "@/lib/ldlf-mt/z3";
import {
  parseTraceInput,
  simulate,
  SimulationError,
  type Simulation,
} from "@/lib/ldlf-mt/simulate";

const MAX_REPEAT = 2;

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  themeVariables: {
    primaryColor: "#e5e5e0",
    primaryTextColor: "#1a1a1a",
    primaryBorderColor: "#6b6b6b",
    lineColor: "#6b6b6b",
    secondaryColor: "#fafaf8",
    tertiaryColor: "#fafaf8",
    background: "#fafaf8",
    mainBkg: "#e5e5e0",
    nodeBorder: "#6b6b6b",
    fontFamily: "var(--font-geist-sans)",
    fontSize: "14px",
  },
});

const examples = [
  { label: "eventually big", formula: "<true*;{x > 100}>end" },
  { label: "stays positive", formula: "[true*;{x <= 0}]ff" },
  {
    label: "ramp up",
    formula: "<{x < 10}*;{x >= 10}*;{x >= 100}>end",
  },
  {
    label: "impossible step",
    formula: "<true*;({x > 10} & {x < 5})>end",
  },
  {
    label: "two variables",
    formula: "<true*;({x > 0} & {y = 2});true*;{x + y > 100}>end",
  },
];

let diagramCounter = 0;

function Diagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let cancelled = false;
    const id = `ldlf-mt-dfa-${diagramCounter++}`;
    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setSvg("");
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  return (
    <div className="overflow-x-auto">
      <div
        className="flex justify-center py-4 min-w-fit"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

function formatWitness(witness: Record<string, number> | undefined): string {
  if (!witness) return "";
  return Object.entries(witness)
    .map(([v, x]) => `${v}=${x}`)
    .join(", ");
}

type Phase =
  | { kind: "z3" }
  | { kind: "translating" }
  | { kind: "checking"; done: number; total: number };

let z3Ready = false;

export default function LdlfMtTool() {
  const [formula, setFormula] = useState("<true*;{x > 0};{x > 100}>end");
  const [result, setResult] = useState<MtResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [simInput, setSimInput] = useState("");
  const [simResult, setSimResult] = useState<Simulation | null>(null);
  const [simError, setSimError] = useState<string | null>(null);

  const traces = useMemo(
    () =>
      result ? enumerateTraces(result.automaton, { maxRepeat: MAX_REPEAT }) : null,
    [result],
  );

  // Lydia is small — fetch it up front. Z3 is ~34 MB, so it waits until the
  // first translate.
  useEffect(() => {
    preload();
  }, []);

  async function run() {
    setError(null);
    setSimResult(null);
    setSimError(null);
    try {
      let api: Z3Api;
      if (z3Ready) {
        api = await loadZ3();
      } else {
        setPhase({ kind: "z3" });
        api = await loadZ3();
        z3Ready = true;
      }
      setPhase({ kind: "translating" });
      const res = await translateMt(formula, {
        api,
        onPhase: (p, done, total) => {
          if (p === "checking")
            setPhase({ kind: "checking", done: done ?? 0, total: total ?? 0 });
        },
      });
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(
        e instanceof SolverUnavailableError
          ? "z3-unavailable"
          : e instanceof EngineUnavailableError
            ? "engine-unavailable"
            : e instanceof Error
              ? e.message
              : "Something went wrong.",
      );
    } finally {
      setPhase(null);
    }
  }

  function runSimulation() {
    if (!result) return;
    setSimError(null);
    setSimResult(null);
    try {
      const assignments = parseTraceInput(simInput, result.variables);
      if (assignments.length === 0) {
        setSimError("Give at least one step, like x = 5; x = 120.");
        return;
      }
      setSimResult(simulate(result.sim, result.predicates, assignments));
    } catch (e) {
      setSimError(
        e instanceof SimulationError || e instanceof Error
          ? e.message
          : "Couldn't run that trace.",
      );
    }
  }

  const pending = phase !== null;
  const buttonLabel =
    phase === null
      ? "translate →"
      : phase.kind === "z3"
        ? "loading z3…"
        : phase.kind === "translating"
          ? "translating…"
          : `checking ${phase.done}/${phase.total}`;

  const simPlaceholder = result
    ? result.variables.map((v) => `${v} = 5`).join(", ") +
      "; " +
      result.variables.map((v) => `${v} = 120`).join(", ")
    : "";

  return (
    <div className="space-y-8">
      {/* Input */}
      <div>
        <label
          htmlFor="mt-formula"
          className="font-mono text-xs tracking-wider text-muted"
        >
          FORMULA
        </label>
        <textarea
          id="mt-formula"
          ref={inputRef}
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              run();
            }
          }}
          spellCheck={false}
          rows={3}
          className="mt-2 w-full resize-y border border-border bg-white/50 px-4 py-3 font-mono text-sm leading-relaxed outline-none focus:border-muted transition-colors"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={pending || formula.trim() === ""}
            className="font-mono text-xs border border-border px-3 py-1.5 hover:border-muted hover:text-foreground text-muted transition-colors disabled:opacity-40 disabled:hover:border-border"
          >
            {buttonLabel}
          </button>
          <span className="font-mono text-xs text-muted">⌘↵</span>
          {phase?.kind === "z3" && (
            <span className="font-mono text-xs text-muted">
              downloading the solver (~34 MB, cached after the first time)
            </span>
          )}
        </div>
      </div>

      {/* Examples */}
      <div>
        <span className="font-mono text-xs tracking-wider text-muted">
          EXAMPLES
        </span>
        <div className="mt-2 flex flex-wrap gap-2">
          {examples.map((example) => (
            <button
              key={example.formula}
              onClick={() => {
                setFormula(example.formula);
                inputRef.current?.focus();
              }}
              className="font-mono text-xs text-muted border border-border px-2 py-1 hover:border-muted hover:text-foreground transition-colors"
            >
              {example.label}
            </button>
          ))}
        </div>
      </div>

      {/* Output */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="font-mono text-xs tracking-wider text-muted">
            AUTOMATON
          </span>
          {result && (result.prunedEdges > 0 || result.prunedStates > 0) && (
            <span className="font-mono text-xs text-muted">
              pruned {result.prunedEdges} impossible edge
              {result.prunedEdges === 1 ? "" : "s"}
              {result.prunedStates > 0 &&
                `, ${result.prunedStates} unreachable state${
                  result.prunedStates === 1 ? "" : "s"
                }`}
            </span>
          )}
        </div>
        <div className="mt-2 border border-border min-h-[200px] flex items-center justify-center px-6 py-8">
          {result ? (
            <Diagram chart={toMermaid(result.automaton)} />
          ) : error === "z3-unavailable" ? (
            <p className="text-sm text-muted text-center max-w-sm leading-relaxed">
              Couldn&apos;t load the Z3 solver. Check your connection and try
              again.
            </p>
          ) : error === "engine-unavailable" ? (
            <p className="text-sm text-muted text-center max-w-sm leading-relaxed">
              Couldn&apos;t load the WebAssembly engine. Check your connection
              and try again.
            </p>
          ) : error ? (
            <p className="font-mono text-sm text-muted text-center max-w-md">
              {error}
            </p>
          ) : (
            <p className="font-mono text-sm text-muted">
              nothing translated yet
            </p>
          )}
        </div>
      </div>

      {/* Alphabet debugger */}
      {result && result.predicates.length > 0 && (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="font-mono text-xs tracking-wider text-muted">
              THE ALPHABET
            </span>
            <span className="font-mono text-xs text-muted">
              {result.minterms.filter((m) => m.status !== "unsat").length} letters,{" "}
              {result.minterms.filter((m) => m.status === "unsat").length} pruned
            </span>
          </div>
          <p className="mt-2 text-xs text-muted leading-relaxed">
            Every combination of the predicates is a candidate letter. Z3 keeps
            the ones some value can realise (shown with a witness) and prunes
            the contradictions (shown with the clashing predicates).
          </p>
          <div className="mt-2 border border-border overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="border-b border-border">
                  {result.predicates.map((p, i) => (
                    <th
                      key={i}
                      className="px-3 py-2 text-left font-normal text-muted whitespace-nowrap"
                    >
                      {p.display}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-left font-normal text-muted w-full">
                    letter
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.minterms.map((m) => (
                  <tr key={m.mask} className={m.status === "unsat" ? "opacity-50" : ""}>
                    {result.predicates.map((_, i) => {
                      const holds = (m.mask & (1 << i)) !== 0;
                      const inConflict =
                        m.status === "unsat" && m.conflict?.includes(i);
                      return (
                        <td
                          key={i}
                          className={`px-3 py-2 whitespace-nowrap ${
                            inConflict
                              ? "text-foreground font-medium"
                              : holds
                                ? ""
                                : "text-muted"
                          }`}
                        >
                          {holds ? "✓" : "✗"}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 whitespace-nowrap">
                      {m.status === "sat" ? (
                        <span className="text-muted">{formatWitness(m.witness)}</span>
                      ) : m.status === "unsat" ? (
                        <span>
                          pruned —{" "}
                          {m.conflict
                            ?.map((i) =>
                              (m.mask & (1 << i)) !== 0
                                ? result.predicates[i].display
                                : result.predicates[i].negatedDisplay,
                            )
                            .join("  ∧  ")}{" "}
                          is contradictory
                        </span>
                      ) : (
                        <span>undecided — kept to stay sound</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Accepted traces */}
      {traces && result && (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="font-mono text-xs tracking-wider text-muted">
              ACCEPTED TRACES
            </span>
            <span className="font-mono text-xs text-muted">
              loops unrolled up to {MAX_REPEAT}×
            </span>
          </div>

          <div className="mt-2 border border-border px-4 py-3">
            {traces.traces.length === 0 ? (
              <p className="font-mono text-sm text-muted py-4 text-center">
                unsatisfiable — no trace is accepted
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {traces.traces.map((trace, i) => (
                  <li
                    key={i}
                    className="font-mono text-xs py-2 overflow-x-auto whitespace-nowrap"
                  >
                    {trace.steps.length === 0
                      ? "ε"
                      : trace.steps
                          .map((_, j) => {
                            const witness = result.edgeWitnesses.get(
                              `${trace.states[j]}->${trace.states[j + 1]}`,
                            );
                            return formatWitness(witness) || trace.steps[j];
                          })
                          .join("  ·  ")}
                  </li>
                ))}
                {traces.truncated && (
                  <li className="font-mono text-xs py-2 text-muted">…</li>
                )}
              </ul>
            )}
          </div>

          {traces.traces.length > 0 && (
            <p className="mt-2 text-xs text-muted leading-relaxed">
              Each step shows one concrete assignment that takes the edge —
              witness values from Z3, not just edge labels.{" "}
              <code className="font-mono">ε</code> is the empty trace.
              {traces.truncated &&
                ` Cut off where a loop would repeat more than ${MAX_REPEAT} times.`}
            </p>
          )}
        </div>
      )}

      {/* Simulator */}
      {result && result.variables.length > 0 && (
        <div>
          <span className="font-mono text-xs tracking-wider text-muted">
            SIMULATE
          </span>
          <p className="mt-2 text-xs text-muted leading-relaxed">
            Run a concrete trace: steps separated by{" "}
            <code className="font-mono">;</code>, each step assigning every
            variable, like{" "}
            <code className="font-mono">{simPlaceholder}</code>.
          </p>
          <textarea
            value={simInput}
            onChange={(e) => setSimInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                runSimulation();
              }
            }}
            spellCheck={false}
            rows={2}
            placeholder={simPlaceholder}
            className="mt-2 w-full resize-y border border-border bg-white/50 px-4 py-3 font-mono text-sm leading-relaxed outline-none focus:border-muted transition-colors placeholder:text-muted/60"
          />
          <div className="mt-3">
            <button
              onClick={runSimulation}
              disabled={simInput.trim() === ""}
              className="font-mono text-xs border border-border px-3 py-1.5 hover:border-muted hover:text-foreground text-muted transition-colors disabled:opacity-40 disabled:hover:border-border"
            >
              run trace →
            </button>
          </div>

          {simError && (
            <p className="mt-3 font-mono text-xs text-muted">{simError}</p>
          )}

          {simResult && (
            <div className="mt-3 border border-border overflow-x-auto">
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 text-left font-normal text-muted">#</th>
                    <th className="px-3 py-2 text-left font-normal text-muted">
                      values
                    </th>
                    <th className="px-3 py-2 text-left font-normal text-muted w-full">
                      satisfies
                    </th>
                    <th className="px-3 py-2 text-left font-normal text-muted">
                      state
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {simResult.steps.map((step, i) => (
                    <tr
                      key={i}
                      className={
                        simResult.deadFrom !== null && i >= simResult.deadFrom
                          ? "opacity-50"
                          : ""
                      }
                    >
                      <td className="px-3 py-2 text-muted">{i + 1}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatWitness(step.assignment)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted">
                        {result.predicates
                          .filter((_, j) => step.holds[j])
                          .map((p) => p.display)
                          .join(", ") || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {step.state}
                        {simResult.deadFrom === i && (
                          <span className="text-muted"> ← dead end</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-border px-3 py-2 font-mono text-xs">
                {simResult.accepted ? (
                  <span>accepted ✓</span>
                ) : (
                  <span className="text-muted">
                    rejected ✗
                    {simResult.deadFrom === -1 &&
                      " — the formula is unsatisfiable, no trace can be accepted"}
                    {simResult.deadFrom !== null &&
                      simResult.deadFrom >= 0 &&
                      ` — after step ${simResult.deadFrom + 1}, no continuation can be accepted`}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
