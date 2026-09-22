"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { examples } from "@/lib/chc/examples";
import { mathLanguage, smtLanguage } from "@/lib/chc/language";
import { compileMath } from "@/lib/chc/math";
import { smtToMath } from "@/lib/chc/convert";
import { readProblem } from "@/lib/chc/problem";
import { parseAll, type SExpr } from "@/lib/chc/sexpr";
import { conjuncts, pretty, tidyInt } from "@/lib/chc/pretty";
import { solveChc, type Interpretation, type SolveOutcome, type Z3Low } from "@/lib/chc/solve";
import { loadSpacer } from "@/lib/chc/z3";

type Notation = "math" | "smt";

const DEFAULT_SOURCE: Record<Notation, string> = {
  math: examples[0].math,
  smt: examples[0].smt,
};
const TIMEOUT_MS = 30_000;

/** Site-palette editor chrome (shared look with the Dafny playground). */
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13.5px", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono)", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "16px 0", caretColor: "#1a1a1a" },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#c9c9c2", border: "none", paddingLeft: "8px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "3ch" },
  ".cm-activeLine": { backgroundColor: "rgba(229, 229, 224, 0.35)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#6b6b6b" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(26, 26, 26, 0.08)",
  },
  ".cm-cursor": { borderLeftColor: "#1a1a1a" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy #b91c1c 1px",
    textUnderlineOffset: "4px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy #a16207 1px",
    textUnderlineOffset: "4px",
  },
  ".cm-gutter-lint": { width: "12px" },
  ".cm-gutter-lint .cm-gutterElement": {
    padding: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-lint-marker": {
    content: "none",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: "#b91c1c",
  },
  ".cm-lint-marker-warning": { backgroundColor: "#a16207" },
  ".cm-lint-marker svg, .cm-lint-marker path": { display: "none" },
  ".cm-tooltip": {
    backgroundColor: "#fafaf8",
    border: "1px solid #e5e5e0",
    fontFamily: "var(--font-geist-mono)",
    fontSize: "12px",
    color: "#1a1a1a",
    maxWidth: "480px",
  },
  ".cm-tooltip-lint": { padding: "2px" },
  ".cm-diagnostic": { borderLeft: "2px solid #b91c1c", padding: "4px 8px" },
  ".cm-diagnostic-warning": { borderLeftColor: "#a16207" },
});

function encodeShare(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShare(param: string): string | null {
  try {
    const binary = atob(param.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

type Located = { start: number; end: number; message: string; severity: "error" | "warning" };

/** What the solver needs from the editor text, in either notation. */
type Frontend =
  | {
      ok: true;
      smt: string;
      /** Source range of each assert / clause, in order. */
      clauseRanges: { start: number; end: number }[];
      /** For math: the generated SMT line of each clause. */
      clauseLines: number[] | null;
      paramNames?: Map<string, string[]>;
    }
  | { ok: false; errors: { start: number; end: number; message: string }[] };

function frontend(notation: Notation, source: string): Frontend {
  if (notation === "math") {
    const c = compileMath(source);
    if (!c.ok) return { ok: false, errors: c.errors };
    return {
      ok: true,
      smt: c.compiled.smt,
      clauseRanges: c.compiled.clauses,
      clauseLines: c.compiled.clauseLines,
      paramNames: new Map(c.compiled.preds.map((p) => [p.name, p.params.map((x) => x.name)])),
    };
  }
  const r = readProblem(source);
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, smt: source, clauseRanges: r.problem.assertRanges, clauseLines: null };
}

/**
 * Moves what the solver said about its SMT-LIB input back onto the editor
 * text. For math notation that's the whole clause the SMT came from.
 */
function locate(source: string, fe: Extract<Frontend, { ok: true }>, outcome: SolveOutcome): Located[] {
  const out: Located[] = [];
  const math = fe.clauseLines !== null;
  const smtAsserts = math ? readProblem(fe.smt) : null;
  const fromSmtOffset = (start: number, end: number) => {
    if (!math) return { start, end };
    const asserts = smtAsserts && smtAsserts.ok ? smtAsserts.problem.assertRanges : [];
    const i = asserts.findIndex((a) => a.start <= start && start < a.end);
    return i >= 0 && fe.clauseRanges[i] ? fe.clauseRanges[i] : { start: 0, end: Math.min(1, source.length) };
  };
  if (outcome.kind === "input-error") {
    for (const e of outcome.errors) out.push({ ...fromSmtOffset(e.start, e.end), message: e.message, severity: "error" });
  }
  if (outcome.kind === "sat" || outcome.kind === "unsat" || outcome.kind === "unknown") {
    for (const w of outcome.warnings) out.push({ ...fromSmtOffset(w.start, w.end), message: w.message, severity: "warning" });
  }
  if (outcome.kind === "z3-error") {
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
    for (const e of outcome.errors) {
      if (math) {
        const i = fe.clauseLines!.indexOf(e.line);
        const r = i >= 0 ? fe.clauseRanges[i] : { start: 0, end: Math.min(1, source.length) };
        out.push({ ...r, message: e.message, severity: "error" });
        continue;
      }
      const lineStart = lineStarts[Math.max(0, Math.min(e.line - 1, lineStarts.length - 1))];
      // Z3 reports where it stopped reading, usually just inside the
      // offending application: mark the innermost expression around it.
      const at = lineStart + Math.max(0, e.column - 1);
      const node = innermostList(source, at);
      out.push({
        start: node ? node.start : lineStart,
        end: node ? node.end : lineStart + 1,
        message: e.message,
        severity: "error",
      });
    }
  }
  return out;
}

function toCm(state: EditorState, located: Located[]): Diagnostic[] {
  const n = state.doc.length;
  return located.map((d) => {
    const from = Math.max(0, Math.min(d.start, n));
    const to = Math.max(Math.min(d.end, n), Math.min(from + 1, n));
    return { from, to, severity: d.severity, message: d.message };
  });
}

function lineCol(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const col = offset - before.lastIndexOf("\n");
  return `${line}:${col}`;
}

function innermostList(source: string, offset: number): SExpr | null {
  let exprs: SExpr[];
  try {
    exprs = parseAll(source);
  } catch {
    return null;
  }
  let best: SExpr | null = null;
  const walk = (e: SExpr) => {
    if (e.kind !== "list" || e.start > offset || e.end <= offset) return;
    best = e;
    e.items.forEach(walk);
  };
  exprs.forEach(walk);
  return best;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function InterpretationView({ interp, raw }: { interp: Interpretation; raw: boolean }) {
  const allInt = interp.params.every((p) => p.sort === "Int");
  const body = raw || !allInt ? interp.body : tidyInt(interp.body);
  const parts = conjuncts(body);
  const signature = `${interp.pred}(${interp.params.map((p) => p.name).join(", ")})`;
  return (
    <li className="py-3">
      <p className="font-mono text-sm">
        {signature}
        <span className="text-muted"> ≡</span>
      </p>
      <div className="mt-1 pl-4 font-mono text-sm leading-relaxed">
        {parts.map((c, i) => (
          <p key={i}>
            {i > 0 && <span className="text-muted">∧ </span>}
            {pretty(c)}
          </p>
        ))}
      </div>
    </li>
  );
}

type Status = "loading" | "ready" | "failed";

export default function ChcTool() {
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const z3Ref = useRef<Z3Low | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [solving, setSolving] = useState(false);
  const [solvingSince, setSolvingSince] = useState(0);
  const [now, setNow] = useState(0);
  const [outcome, setOutcome] = useState<SolveOutcome | null>(null);
  const [located, setLocated] = useState<{ source: string; diags: Located[]; smt: string | null }>({
    source: "",
    diags: [],
    smt: null,
  });
  const [notation, setNotationState] = useState<Notation>("math");
  const notationRef = useRef<Notation>("math");
  const langCompartment = useRef(new Compartment());
  const [notice, setNotice] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const applyInline = useCallback((source: string, diags: Located[]) => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() !== source) return;
    view.dispatch(setDiagnostics(view.state, toCm(view.state, diags)));
  }, []);

  /**
   * Latest-wins: an edit during a solve interrupts Z3 and queues the new
   * source; the interrupted run's result is dropped.
   */
  const runSolve = useCallback(
    async (source: string) => {
      const z3 = z3Ref.current;
      if (!z3 || source.trim() === "") return;
      if (busyRef.current) {
        pendingRef.current = source;
        stopRef.current?.();
        return;
      }
      busyRef.current = true;
      setSolving(true);
      setSolvingSince(performance.now());
      try {
        const fe = frontend(notationRef.current, source);
        if (!fe.ok) {
          const diags = fe.errors.map((e) => ({ ...e, severity: "error" as const }));
          if (pendingRef.current === null) {
            setOutcome({ kind: "input-error", errors: fe.errors });
            setLocated({ source, diags, smt: null });
            applyInline(source, diags);
          }
          return;
        }
        const result = await solveChc(z3, fe.smt, {
          timeoutMs: TIMEOUT_MS,
          paramNames: fe.paramNames,
          onStart: (stop) => {
            stopRef.current = stop;
          },
        });
        if (pendingRef.current === null) {
          const diags = locate(source, fe, result);
          setOutcome(result);
          setLocated({ source, diags, smt: fe.clauseLines ? fe.smt : null });
          applyInline(source, diags);
        }
      } catch (e) {
        console.warn("[chc] solve failed", e);
        setOutcome({
          kind: "z3-error",
          errors: [{ line: 0, column: 0, message: e instanceof Error ? e.message : "Z3 failed." }],
          raw: "",
        });
      } finally {
        stopRef.current = null;
        busyRef.current = false;
        setSolving(false);
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next !== null) void runSolveRef.current(next);
      }
    },
    [applyInline],
  );
  const runSolveRef = useRef(runSolve);
  runSolveRef.current = runSolve;

  const syncUrl = useCallback((source: string) => {
    const url = new URL(window.location.href);
    const n = notationRef.current;
    if (source === DEFAULT_SOURCE[n] || source.trim() === "") url.searchParams.delete("code");
    else url.searchParams.set("code", encodeShare(source));
    if (n === "smt") url.searchParams.set("lang", "smt");
    else url.searchParams.delete("lang");
    window.history.replaceState(null, "", url);
  }, []);

  const schedule = useCallback(
    (source: string) => {
      if (timer.current) clearTimeout(timer.current);
      // Syntax and sort errors show immediately; Spacer runs once typing
      // pauses.
      const fe = frontend(notationRef.current, source);
      applyInline(source, fe.ok ? [] : fe.errors.map((e) => ({ ...e, severity: "error" as const })));
      timer.current = setTimeout(() => {
        syncUrl(source);
        void runSolveRef.current(source);
      }, 700);
    },
    [applyInline, syncUrl],
  );
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  useEffect(() => {
    if (!editorHost.current || viewRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const shared = params.get("code");
    const sharedDoc = shared ? decodeShare(shared) : null;
    // Links made before the math notation existed carry SMT-LIB and no
    // lang param: fall back to whichever notation the text parses as.
    const initialNotation: Notation =
      params.get("lang") === "smt" ||
      (params.get("lang") === null &&
        sharedDoc !== null &&
        !compileMath(sharedDoc).ok &&
        readProblem(sharedDoc).ok)
        ? "smt"
        : "math";
    notationRef.current = initialNotation;
    setNotationState(initialNotation);
    const initialDoc = sharedDoc || DEFAULT_SOURCE[initialNotation];
    const view = new EditorView({
      parent: editorHost.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          indentUnit.of("  "),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          langCompartment.current.of(initialNotation === "math" ? mathLanguage() : smtLanguage()),
          lintGutter(),
          editorTheme,
          keymap.of([
            {
              key: "Mod-Enter",
              run: (v) => {
                void runSolveRef.current(v.state.doc.toString());
                return true;
              },
            },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) scheduleRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const z3 = await loadSpacer();
        if (cancelled) return;
        z3Ref.current = z3;
        setStatus("ready");
        const view = viewRef.current;
        if (view) void runSolveRef.current(view.state.doc.toString());
      } catch (e) {
        console.warn("[chc] z3 failed to load", e);
        if (!cancelled) setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Elapsed-time ticker while Spacer works.
  useEffect(() => {
    if (!solving) return;
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [solving]);

  const selectClause = useCallback((index: number) => {
    const view = viewRef.current;
    if (!view) return;
    const fe = frontend(notationRef.current, view.state.doc.toString());
    if (!fe.ok) return;
    const range = fe.clauseRanges[index - 1];
    if (!range) return;
    view.dispatch({ selection: { anchor: range.start, head: range.end }, scrollIntoView: true });
    view.focus();
  }, []);

  /**
   * Switches notation, carrying the problem across: an untouched example
   * swaps for its twin (comments intact), anything else is converted.
   */
  const switchNotation = useCallback(
    (next: Notation) => {
      const view = viewRef.current;
      const cur = notationRef.current;
      if (!view || next === cur) return;
      const source = view.state.doc.toString();
      let text: string | null = null;
      const twin = examples.find((e) => e[cur] === source);
      if (twin) text = twin[next];
      else if (source.trim() === "") text = "";
      else if (next === "smt") {
        const c = compileMath(source);
        if (c.ok) text = "; compiled from math notation\n" + c.compiled.smt;
        else {
          setNotice("Fix the errors first, then switch.");
          return;
        }
      } else {
        const m = smtToMath(source);
        if (m.ok) text = m.text;
        else {
          setNotice(`Can't write this in math notation: ${m.reason}.`);
          return;
        }
      }
      setNotice(null);
      notationRef.current = next;
      setNotationState(next);
      view.dispatch({
        effects: langCompartment.current.reconfigure(next === "math" ? mathLanguage() : smtLanguage()),
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
      syncUrl(text);
    },
    [syncUrl],
  );

  const loadExample = useCallback((source: string) => {
    setNotice(null);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
    setOutcome(null);
    view.focus();
  }, []);

  const copyLink = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    syncUrl(view.state.doc.toString());
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The address bar still has the link.
    }
  }, [syncUrl]);

  const statusText =
    status === "loading"
      ? "loading z3 (~34 MB, cached)…"
      : solving
        ? `spacer is working… ${formatMs(Math.max(0, now - solvingSince))}`
        : "";

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      {/* Editor */}
      <div className="flex-1 min-w-0 min-h-[45vh] lg:min-h-0 border-b lg:border-b-0 lg:border-r border-border flex flex-col">
        <div className="shrink-0 px-6 py-2 border-b border-border flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-mono text-xs tracking-wider text-muted">NOTATION</span>
          {(["math", "smt"] as const).map((n) => (
            <button
              key={n}
              onClick={() => switchNotation(n)}
              className={`font-mono text-xs transition-colors ${
                notation === n
                  ? "text-foreground underline underline-offset-4"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {n === "math" ? "math" : "smt-lib"}
            </button>
          ))}
          {notice && <span className="font-mono text-xs text-muted">{notice}</span>}
        </div>
        <div className="flex-1 min-h-0 relative">
          <div ref={editorHost} className="absolute inset-0" />
        </div>
      </div>

      {/* Side panel */}
      <div className="lg:w-[26rem] xl:w-[30rem] shrink-0 flex flex-col min-h-0 overflow-y-auto">
        {/* Verdict */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs tracking-wider text-muted">VERDICT</span>
            <span className="flex items-baseline gap-3">
              {statusText && <span className="font-mono text-xs text-muted">{statusText}</span>}
              {solving && (
                <button
                  onClick={() => stopRef.current?.()}
                  className="font-mono text-xs text-muted border border-border px-2 py-0.5 hover:border-muted hover:text-foreground transition-colors"
                >
                  stop
                </button>
              )}
            </span>
          </div>
          <div className="mt-3">
            <Verdict outcome={outcome} status={status} located={located} />
          </div>
        </div>

        {/* Model */}
        {outcome?.kind === "sat" && (
          <div className="px-6 py-5 border-b border-border">
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-mono text-xs tracking-wider text-muted">INTERPRETATIONS</span>
              <button
                onClick={() => setShowRaw((r) => !r)}
                className="font-mono text-xs text-muted hover:text-foreground transition-colors"
              >
                {showRaw ? "tidy integer bounds" : "as z3 printed it"}
              </button>
            </div>
            <ul className="mt-1 divide-y divide-border">
              {outcome.interpretations.map((interp) => (
                <InterpretationView key={interp.pred} interp={interp} raw={showRaw} />
              ))}
            </ul>
            <ClauseChecks outcome={outcome} onSelect={selectClause} />
          </div>
        )}

        {/* Counterexample */}
        {outcome?.kind === "unsat" && (
          <div className="px-6 py-5 border-b border-border">
            <span className="font-mono text-xs tracking-wider text-muted">DERIVATION OF FALSE</span>
            {outcome.steps.length === 0 ? (
              <p className="mt-3 font-mono text-xs text-muted leading-relaxed">
                Z3&apos;s proof didn&apos;t contain a derivation this page could read.
              </p>
            ) : (
              <ol className="mt-3 space-y-1.5">
                {outcome.steps.map((step, i) => (
                  <li key={i} className="font-mono text-sm flex gap-3">
                    <span className="text-muted w-6 shrink-0 text-right">{i + 1}</span>
                    <span className="flex-1 min-w-0">
                      <span className={step.pred === null ? "font-semibold" : ""}>
                        {step.pred === null
                          ? "false"
                          : step.args.length === 0
                            ? step.pred
                            : `${step.pred}(${step.args.map(pretty).join(", ")})`}
                      </span>
                      <span className="block text-xs text-muted">
                        {step.clause !== null ? (
                          <button
                            onClick={() => selectClause(step.clause!)}
                            className="underline underline-offset-2 decoration-border hover:text-foreground transition-colors"
                          >
                            clause {step.clause}
                          </button>
                        ) : (
                          "unattributed step"
                        )}
                        {step.premises.length > 0
                          ? ` from ${step.premises.map((p) => p + 1).join(", ")}`
                          : " (a fact)"}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-4 text-xs leading-relaxed text-muted">
              Each step is a ground instance of one clause: its premises are
              earlier steps, and its constraint holds for these values. The
              clause for each step was found by asking Z3 again, so the
              derivation is checked against the clauses as you wrote them.
            </p>
          </div>
        )}

        {/* Raw output */}
        {outcome && (outcome.kind === "sat" || outcome.kind === "unsat") && (
          <details className="px-6 py-4 border-b border-border group">
            <summary className="font-mono text-xs tracking-wider text-muted cursor-pointer hover:text-foreground transition-colors">
              RAW {outcome.kind === "sat" ? "MODEL" : "PROOF"}
            </summary>
            <pre className="mt-3 font-mono text-xs leading-relaxed text-accent whitespace-pre-wrap break-all max-h-80 overflow-auto">
              {outcome.raw.trim()}
            </pre>
          </details>
        )}

        {/* Generated SMT-LIB */}
        {notation === "math" && located.smt && (
          <details className="px-6 py-4 border-b border-border">
            <summary className="font-mono text-xs tracking-wider text-muted cursor-pointer hover:text-foreground transition-colors">
              GENERATED SMT-LIB
            </summary>
            <pre className="mt-3 font-mono text-xs leading-relaxed text-accent whitespace-pre-wrap break-all max-h-80 overflow-auto">
              {located.smt.trim()}
            </pre>
          </details>
        )}

        {/* Examples */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs tracking-wider text-muted">EXAMPLES</span>
            <button
              onClick={copyLink}
              className="font-mono text-xs text-muted hover:text-foreground transition-colors"
            >
              {copied ? "link copied" : "share these clauses"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {examples.map((example) => (
              <button
                key={example.label}
                onClick={() => loadExample(example[notation])}
                className="font-mono text-xs text-muted border border-border px-2 py-1 hover:border-muted hover:text-foreground transition-colors"
              >
                {example.label}
              </button>
            ))}
          </div>
        </div>

        {/* About */}
        <div className="px-6 py-5">
          <span className="font-mono text-xs tracking-wider text-muted">WHAT THIS IS</span>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            A constrained Horn clause says: if these predicates hold and this
            constraint holds, then that predicate holds, or false. Program
            verification reduces to them. Unknown predicates stand for loop
            invariants and procedure summaries, and query clauses, with false
            in the head, encode the assertions.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            In math notation, each line is a clause and its variables are
            universally quantified, with sorts inferred. Declare predicates
            with <code className="font-mono text-xs">pred p(x: int)</code>.
            Operators are spelled as in Dafny or as symbols: &amp;&amp; ∧,
            || ∨, ! ¬, ==&gt; ⇒, != ≠, &lt;= ≤. Comparisons chain, so{" "}
            <code className="font-mono text-xs">0 &lt;= i &lt; n</code> works.
            Primed names like <code className="font-mono text-xs">x&apos;</code>{" "}
            are ordinary variables, handy for next states. A head that
            isn&apos;t a predicate is the assertion. The toggle converts to
            and from SMT-LIB.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            This page runs{" "}
            <a
              href="https://github.com/Z3Prover/z3"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              Z3
            </a>
            &apos;s{" "}
            <a
              href="https://arieg.bitbucket.io/pdf/gurfinkel_cav15.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              Spacer
            </a>{" "}
            engine, compiled to WebAssembly, on clauses in the SMT-LIB format
            used by{" "}
            <a
              href="https://chc-comp.github.io"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              CHC-COMP
            </a>
            . Sat means the clauses have a model. Its interpretations are
            invariants that prove every query unreachable, and each clause is
            re-checked under them in a fresh solver. Unsat means false is
            derivable, and the derivation is a concrete counterexample. It
            solves when you pause typing, with a {TIMEOUT_MS / 1000}-second
            limit. Z3&apos;s inlining of single-use predicates is switched
            off so every predicate you declare shows up in the answer.
          </p>
        </div>
      </div>
    </div>
  );
}

function Verdict({
  outcome,
  status,
  located,
}: {
  outcome: SolveOutcome | null;
  status: Status;
  located: { source: string; diags: Located[] };
}) {
  if (status === "failed") {
    return (
      <p className="font-mono text-sm text-muted leading-relaxed">
        Z3 failed to load. Check your connection and reload.
      </p>
    );
  }
  if (!outcome) {
    return (
      <p className="font-mono text-sm text-muted">
        {status === "loading" ? "warming up. Solving starts automatically." : "solving…"}
      </p>
    );
  }
  switch (outcome.kind) {
    case "sat":
      return (
        <p className="font-mono text-sm">
          sat
          <span className="text-muted">
            {" "}
            · safe · the clauses have a model · {formatMs(outcome.ms)}
          </span>
        </p>
      );
    case "unsat":
      return (
        <p className="font-mono text-sm">
          unsat
          <span className="text-muted">
            {" "}
            · unsafe · false is derivable in {Math.max(0, outcome.steps.length - 1)} step
            {outcome.steps.length - 1 === 1 ? "" : "s"} · {formatMs(outcome.ms)}
          </span>
        </p>
      );
    case "unknown":
      return (
        <p className="font-mono text-sm">
          unknown
          <span className="text-muted"> · {outcome.reason}</span>
        </p>
      );
    case "stopped":
      return <p className="font-mono text-sm text-muted">stopped</p>;
    case "input-error":
    case "z3-error":
      return (
        <ul className="space-y-1">
          {located.diags
            .filter((d) => d.severity === "error")
            .map((d, i) => (
              <li key={i} className="font-mono text-xs text-muted leading-relaxed">
                <span>{lineCol(located.source, d.start)} </span>
                {d.message}
              </li>
            ))}
        </ul>
      );
  }
}

function ClauseChecks({
  outcome,
  onSelect,
}: {
  outcome: Extract<SolveOutcome, { kind: "sat" }>;
  onSelect: (i: number) => void;
}) {
  const failed = outcome.checks.filter((c) => c.ok === false);
  const unknown = outcome.checks.filter((c) => c.ok === null);
  return (
    <p className="mt-3 text-xs leading-relaxed text-muted">
      {failed.length === 0 && unknown.length === 0 ? (
        <>
          Checked: all {outcome.checks.length} clauses are valid with these
          interpretations substituted in, by a separate Z3 query each.
        </>
      ) : (
        <>
          Re-check under this model:{" "}
          {outcome.checks.map((c, i) => (
            <span key={c.clause}>
              {i > 0 && ", "}
              <button
                onClick={() => onSelect(c.clause)}
                className="underline underline-offset-2 decoration-border hover:text-foreground transition-colors"
              >
                clause {c.clause}
              </button>{" "}
              {c.ok === true ? "holds" : c.ok === false ? "fails" : "unknown"}
            </span>
          ))}
          .
        </>
      )}
    </p>
  );
}
