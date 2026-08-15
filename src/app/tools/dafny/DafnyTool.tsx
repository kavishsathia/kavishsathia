"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
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
import {
  check,
  verify,
  loadRuntime,
  initSmtBridge,
  EngineUnavailableError,
  SolverUnavailableError,
  type DafnyDiagnostic,
  type VerifyOutcome,
} from "@/lib/dafny/engine";
import { dafnyLanguage } from "@/lib/dafny/language";

const DEFAULT_PROGRAM = `method Max(a: int, b: int) returns (m: int)
  ensures m >= a && m >= b
  ensures m == a || m == b
{
  if a >= b { m := a; } else { m := b; }
}`;

const examples = [
  {
    label: "first proof",
    program: DEFAULT_PROGRAM,
  },
  {
    label: "loop invariant",
    program: `method Sum(n: nat) returns (s: nat)
  ensures s == n * (n + 1) / 2
{
  s := 0;
  var i := 0;
  while i < n
    invariant 0 <= i <= n
    invariant s == i * (i + 1) / 2
  {
    i := i + 1;
    s := s + i;
  }
}`,
  },
  {
    label: "binary search",
    program: `method BinarySearch(a: array<int>, key: int) returns (index: int)
  requires forall i, j :: 0 <= i < j < a.Length ==> a[i] <= a[j]
  ensures 0 <= index ==> index < a.Length && a[index] == key
  ensures index < 0 ==> forall k :: 0 <= k < a.Length ==> a[k] != key
{
  var lo, hi := 0, a.Length;
  while lo < hi
    invariant 0 <= lo <= hi <= a.Length
    invariant forall k :: 0 <= k < lo ==> a[k] != key
    invariant forall k :: hi <= k < a.Length ==> a[k] != key
  {
    var mid := (lo + hi) / 2;
    if a[mid] < key {
      lo := mid + 1;
    } else if key < a[mid] {
      hi := mid;
    } else {
      return mid;
    }
  }
  return -1;
}`,
  },
  {
    label: "fibonacci",
    program: `function Fib(n: nat): nat
{
  if n < 2 then n else Fib(n - 1) + Fib(n - 2)
}

method ComputeFib(n: nat) returns (f: nat)
  ensures f == Fib(n)
{
  if n == 0 { return 0; }
  var prev, cur := 0, 1;
  var i := 1;
  while i < n
    invariant 1 <= i <= n
    invariant prev == Fib(i - 1) && cur == Fib(i)
  {
    prev, cur := cur, prev + cur;
    i := i + 1;
  }
  return cur;
}`,
  },
  {
    label: "a bug, found",
    program: `method Abs(x: int) returns (y: int)
  ensures y >= 0 && (y == x || y == -x)
{
  y := x;  // wrong: forgot the negative case
}`,
  },
];

/** Site-palette editor chrome. */
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13.5px",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-geist-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "16px 0",
    caretColor: "#1a1a1a",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "#c9c9c2",
    border: "none",
    paddingLeft: "8px",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "3ch" },
  ".cm-activeLine": { backgroundColor: "rgba(229, 229, 224, 0.35)" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "#6b6b6b",
  },
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

type EngineStatus = "loading-dafny" | "loading-z3" | "ready" | "failed";

// URL-safe base64 for the ?code= sharing param.
function encodeShare(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShare(param: string): string | null {
  try {
    const binary = atob(param.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function toCmDiagnostics(state: EditorState, diags: DafnyDiagnostic[]): Diagnostic[] {
  const doc = state.doc;
  const out: Diagnostic[] = [];
  for (const d of diags) {
    if (d.line < 1 || d.line > doc.lines) continue;
    const lineInfo = doc.line(d.line);
    const from = Math.min(lineInfo.from + Math.max(0, d.column - 1), lineInfo.to);
    let to = from;
    if (d.endLine >= d.line && d.endLine <= doc.lines) {
      const endInfo = doc.line(d.endLine);
      to = Math.min(endInfo.from + Math.max(0, d.endColumn - 1), endInfo.to);
    }
    if (to <= from) to = Math.min(from + 1, lineInfo.to);
    const related = d.related
      .map((r) => `${r.line}:${r.column} ${r.message}`)
      .join("\n");
    out.push({
      from,
      to,
      severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
      message: related ? `${d.message}\n${related}` : d.message,
      source: d.source || undefined,
    });
  }
  return out;
}

export default function DafnyTool() {
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineStatusRef = useRef<EngineStatus>("loading-dafny");
  const verifyBusyRef = useRef(false);
  const pendingVerifyRef = useRef<string | null>(null);

  const [engineStatus, setEngineStatus] = useState<EngineStatus>("loading-dafny");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Push diagnostics into the editor iff the doc still matches `source`. */
  const applyInline = useCallback((source: string, diags: DafnyDiagnostic[]) => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() !== source) return;
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state, diags)));
  }, []);

  /** Fast pass: parse + resolve only, for squiggles between verify runs. */
  const runCheck = useCallback(
    async (source: string) => {
      if (engineStatusRef.current === "failed") return;
      try {
        const outcome = await check(source);
        applyInline(source, outcome.diagnostics);
      } catch (e) {
        console.warn("[dafny] live check failed", e);
      }
    },
    [applyInline],
  );

  /**
   * The full pipeline, latest-wins: if a run is in flight the newest source
   * waits its turn, and intermediate edits are dropped.
   */
  const runVerify = useCallback(
    async (source: string) => {
      if (engineStatusRef.current === "failed" || source.trim() === "") return;
      if (verifyBusyRef.current) {
        pendingVerifyRef.current = source;
        return;
      }
      verifyBusyRef.current = true;
      setVerifying(true);
      try {
        const outcome = await verify(source);
        setError(null);
        setResult(outcome);
        applyInline(source, outcome.diagnostics);
      } catch (e) {
        setResult(null);
        setError(
          e instanceof SolverUnavailableError
            ? "Couldn't load the Z3 solver. Check your connection and try again."
            : e instanceof EngineUnavailableError
              ? `Engine error: ${e.message}`
              : e instanceof Error
                ? e.message
                : "Something went wrong.",
        );
      } finally {
        verifyBusyRef.current = false;
        setVerifying(false);
        const next = pendingVerifyRef.current;
        pendingVerifyRef.current = null;
        if (next !== null && next !== source) {
          void runVerifyRef.current(next);
        }
      }
    },
    [applyInline],
  );

  const runVerifyRef = useRef(runVerify);
  runVerifyRef.current = runVerify;

  /** Keep the address bar shareable: ?code= mirrors the editor on idle. */
  const syncUrl = useCallback((source: string) => {
    const url = new URL(window.location.href);
    if (source === DEFAULT_PROGRAM || source.trim() === "") {
      url.searchParams.delete("code");
    } else {
      url.searchParams.set("code", encodeShare(source));
    }
    window.history.replaceState(null, "", url);
  }, []);

  /** Debounced live pipeline: quick squiggles, then a full verify on idle. */
  const scheduleLive = useCallback(
    (source: string) => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
      if (verifyTimer.current) clearTimeout(verifyTimer.current);
      checkTimer.current = setTimeout(() => runCheckRef.current(source), 400);
      verifyTimer.current = setTimeout(() => {
        syncUrl(source);
        void runVerifyRef.current(source);
      }, 900);
    },
    [syncUrl],
  );

  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;
  const scheduleLiveRef = useRef(scheduleLive);
  scheduleLiveRef.current = scheduleLive;


  // Editor setup.
  useEffect(() => {
    if (!editorHost.current || viewRef.current) return;
    const shared = new URLSearchParams(window.location.search).get("code");
    const initialDoc = (shared && decodeShare(shared)) || DEFAULT_PROGRAM;
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
          dafnyLanguage(),
          lintGutter(),
          editorTheme,
          keymap.of([
            {
              key: "Mod-Enter",
              run: (v) => {
                void runVerifyRef.current(v.state.doc.toString());
                return true;
              },
            },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              scheduleLiveRef.current(update.state.doc.toString());
            }
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

  // Boot everything up front — live verification needs both engines.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadRuntime();
        if (cancelled) return;
        // Squiggles can start while z3 downloads.
        const view = viewRef.current;
        if (view) void runCheckRef.current(view.state.doc.toString());
        engineStatusRef.current = "loading-z3";
        setEngineStatus("loading-z3");
        await initSmtBridge();
        if (cancelled) return;
        engineStatusRef.current = "ready";
        setEngineStatus("ready");
        const v = viewRef.current;
        if (v) void runVerifyRef.current(v.state.doc.toString());
      } catch {
        if (cancelled) return;
        engineStatusRef.current = "failed";
        setEngineStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
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
      // Clipboard can be denied; the address bar still has the link.
    }
  }, [syncUrl]);

  const loadExample = useCallback((program: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: program },
    });
    setResult(null);
    setError(null);
    view.focus();
  }, []);

  const statusText =
    engineStatus === "loading-dafny"
      ? "loading dafny (~10 MB, cached)…"
      : engineStatus === "loading-z3"
        ? "loading z3 (~34 MB, cached)…"
        : engineStatus === "failed"
          ? ""
          : verifying
            ? "verifying…"
            : "";

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      {/* Editor */}
      <div className="flex-1 min-w-0 min-h-[45vh] lg:min-h-0 border-b lg:border-b-0 lg:border-r border-border relative">
        <div ref={editorHost} className="absolute inset-0" />
      </div>

      {/* Side panel */}
      <div className="lg:w-[26rem] xl:w-[30rem] shrink-0 flex flex-col min-h-0 overflow-y-auto">
        {/* Verdict */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs tracking-wider text-muted">
              VERDICT
            </span>
            {statusText && (
              <span className="font-mono text-xs text-muted">{statusText}</span>
            )}
          </div>
          <div className="mt-3">
            {result ? (
              <div className="space-y-3">
                <p className="font-mono text-sm">
                  {result.ok ? (
                    <span>
                      verified
                      <span className="text-muted">
                        {" "}
                        — {result.verified} proof obligation
                        {result.verified === 1 ? "" : "s"} discharged
                      </span>
                    </span>
                  ) : result.error ? (
                    <span className="text-muted">
                      did not verify — {result.error}
                    </span>
                  ) : (
                    <span className="text-muted">
                      did not verify —{" "}
                      {[
                        result.errors > 0 &&
                          `${result.errors} error${result.errors === 1 ? "" : "s"}`,
                        result.timeouts > 0 &&
                          `${result.timeouts} timeout${result.timeouts === 1 ? "" : "s"}`,
                        result.inconclusive > 0 &&
                          `${result.inconclusive} inconclusive`,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      {result.verified > 0 &&
                        `; ${result.verified} obligation${
                          result.verified === 1 ? "" : "s"
                        } still verified`}
                    </span>
                  )}
                </p>

                {result.diagnostics.length > 0 && (
                  <ul className="divide-y divide-border border-t border-border">
                    {result.diagnostics.map((d, i) => (
                      <li key={i} className="py-3">
                        <p className="font-mono text-xs leading-relaxed">
                          <button
                            className="text-muted hover:text-foreground transition-colors"
                            onClick={() => {
                              const view = viewRef.current;
                              if (!view || d.line < 1 || d.line > view.state.doc.lines)
                                return;
                              const pos =
                                view.state.doc.line(d.line).from +
                                Math.max(0, d.column - 1);
                              view.dispatch({
                                selection: { anchor: pos },
                                scrollIntoView: true,
                              });
                              view.focus();
                            }}
                          >
                            {d.line}:{d.column}
                          </button>{" "}
                          <span className={d.severity === 1 ? "" : "text-muted"}>
                            {d.message}
                          </span>
                        </p>
                        {d.related.map((r, j) => (
                          <p
                            key={j}
                            className="font-mono text-xs text-muted mt-1 pl-4 leading-relaxed"
                          >
                            {r.line}:{r.column} {r.message}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : error ? (
              <p className="font-mono text-sm text-muted leading-relaxed">{error}</p>
            ) : (
              <p className="font-mono text-sm text-muted">
                {engineStatus === "failed"
                  ? "the engine failed to load — check your connection and reload"
                  : engineStatus === "ready"
                    ? "verifying…"
                    : "warming up — verification starts automatically"}
              </p>
            )}
          </div>
        </div>

        {/* Examples */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs tracking-wider text-muted">
              EXAMPLES
            </span>
            <button
              onClick={copyLink}
              className="font-mono text-xs text-muted hover:text-foreground transition-colors"
            >
              {copied ? "link copied" : "share this program"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {examples.map((example) => (
              <button
                key={example.label}
                onClick={() => loadExample(example.program)}
                className="font-mono text-xs text-muted border border-border px-2 py-1 hover:border-muted hover:text-foreground transition-colors"
              >
                {example.label}
              </button>
            ))}
          </div>
        </div>

        {/* About */}
        <div className="px-6 py-5">
          <span className="font-mono text-xs tracking-wider text-muted">
            WHAT THIS IS
          </span>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            The actual{" "}
            <a
              href="https://dafny.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              Dafny
            </a>{" "}
            verifier — Dafny 4.11 and{" "}
            <a
              href="https://github.com/boogie-org/boogie"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              Boogie
            </a>{" "}
            3.5.5, the same assemblies the CLI runs — executing on the .NET
            runtime compiled to WebAssembly. Boogie normally pipes SMT-LIB to a{" "}
            <a
              href="https://github.com/Z3Prover/z3"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              Z3
            </a>{" "}
            subprocess; here that pipe is rerouted into Z3 wasm. Everything —
            parsing, resolution, verification-condition generation, solving —
            happens on your machine.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            It verifies as you type: parse and type errors appear inline
            almost immediately, and the full pipeline — every proof obligation
            discharged by Z3, with a 15-second solver limit each — re-runs
            whenever you pause. If it verifies, that&apos;s a proof about all
            inputs — not a test suite.
          </p>
        </div>
      </div>
    </div>
  );
}
