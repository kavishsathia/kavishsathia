"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import {
  EngineUnavailableError,
  preload,
  toMermaid,
  translate,
  type Automaton,
} from "@/lib/ldlf/engine";
import { enumerateTraces, formatTrace } from "@/lib/ldlf/traces";

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
  { label: "eventually b", formula: "<true*;b>end" },
  { label: "a then eventually b", formula: "<true*;a;true*;b>end" },
  { label: "always a", formula: "[true*;!a]ff" },
  { label: "even length", formula: "<(true;true)*>end" },
  { label: "request then response", formula: "<true*;(!request + true*;response)>end" },
];

let diagramCounter = 0;

function Diagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let cancelled = false;
    const id = `ldlf-dfa-${diagramCounter++}`;
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
    <div
      className="flex justify-center py-4"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default function LdlfTool() {
  const [formula, setFormula] = useState("<true*;a;true*;b>end");
  const [automaton, setAutomaton] = useState<Automaton | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const traces = useMemo(
    () => (automaton ? enumerateTraces(automaton, { maxRepeat: MAX_REPEAT }) : null),
    [automaton],
  );

  // Fetch the wasm as soon as the page is interactive so the first translate
  // doesn't pay for the download.
  useEffect(() => {
    preload();
  }, []);

  async function run() {
    setPending(true);
    setError(null);
    try {
      setAutomaton(await translate(formula));
    } catch (e) {
      setAutomaton(null);
      setError(
        e instanceof EngineUnavailableError
          ? "engine-unavailable"
          : e instanceof Error
            ? e.message
            : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Input */}
      <div>
        <label
          htmlFor="formula"
          className="font-mono text-xs tracking-wider text-muted"
        >
          FORMULA
        </label>
        <textarea
          id="formula"
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
            {pending ? "translating…" : "translate →"}
          </button>
          <span className="font-mono text-xs text-muted">⌘↵</span>
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
        <span className="font-mono text-xs tracking-wider text-muted">
          AUTOMATON
        </span>
        <div className="mt-2 border border-border min-h-[200px] flex items-center justify-center px-6 py-8">
          {automaton ? (
            <Diagram chart={toMermaid(automaton)} />
          ) : error === "engine-unavailable" ? (
            <p className="text-sm text-muted text-center max-w-sm leading-relaxed">
              Couldn&apos;t load the WebAssembly engine. Check your connection
              and try again.
            </p>
          ) : error ? (
            <p className="font-mono text-sm text-muted text-center">{error}</p>
          ) : (
            <p className="font-mono text-sm text-muted">
              nothing translated yet
            </p>
          )}
        </div>
      </div>

      {/* Accepted traces */}
      {traces && (
        <div>
          <div className="flex items-baseline justify-between gap-4">
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
                    {formatTrace(trace)}
                  </li>
                ))}
                {traces.truncated && (
                  <li className="font-mono text-xs py-2 text-muted">…</li>
                )}
              </ul>
            )}
          </div>

          {traces.truncated && traces.traces.length > 0 && (
            <p className="mt-2 text-xs text-muted leading-relaxed">
              Cut off where a loop would repeat more than {MAX_REPEAT} times.
              Traces are listed shortest first; each step is the edge condition
              taken, and{" "}
              <code className="font-mono">ε</code> is the empty trace.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
