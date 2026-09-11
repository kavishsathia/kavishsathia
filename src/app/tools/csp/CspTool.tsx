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
import { cspLanguage } from "@/lib/csp/language";
import { checkSyntax, checkTrace, type CheckResult } from "@/lib/csp/verify";
import type { Loc } from "@/lib/csp/ast";

type Example = { label: string; model: string; proc: string; trace: string };

const DINING = `// PAT's dining philosophers, verbatim from the tutorial.
#define N 5;

Phil(i) = get.i.(i+1)%N -> get.i.i -> eat.i -> put.i.(i+1)%N -> put.i.i -> Phil(i);
Fork(x) = get.x.x -> put.x.x -> Fork(x) [] get.(x-1)%N.x -> put.(x-1)%N.x -> Fork(x);

College() = ||x:{0..N-1}@(Phil(x)||Fork(x));

#assert College() deadlockfree;`;

const examples: Example[] = [
  {
    label: "dining philosophers",
    model: DINING,
    proc: "College()",
    trace: "get.0.1, get.0.0, eat.0, put.0.1, put.0.0, get.1.2",
  },
  {
    label: "the deadlock",
    model: DINING,
    proc: "College()",
    trace: "get.0.1, get.1.2, get.2.3, get.3.4, get.4.0",
  },
  {
    label: "a fork taken twice",
    model: DINING,
    proc: "College()",
    trace: "get.0.1, get.4.0, get.0.0",
  },
  {
    label: "internal choice",
    model: `// The machine picks the drink; the environment cannot force it.
VM() = coin -> (tea -> VM() <> coffee -> VM());

// The trace checker follows every branch the model could have taken,
// so both coffee and tea are accepted after a coin.
#assert VM() deadlockfree;`,
    proc: "VM()",
    trace: "coin, coffee, coin, tea, coin",
  },
  {
    label: "shared variables",
    model: `// Events carry programs that update global state atomically.
var count = 0;

Inc() = inc{count = count + 1;} -> Inc();
Dec() = [count > 0] dec{count = count - 1;} -> Dec();

// [count > 0] is a guard: dec is only enabled while it holds.
System() = Inc() ||| Dec();

#assert System() |= [] (count >= 0);`,
    proc: "System()",
    trace: "inc, inc, dec, dec, dec",
  },
  {
    label: "synchronous channel",
    model: `// A channel of size 0 is a handshake: the send and the matching
// receive happen together, shown in the trace as c.value.
channel c 0;

Sender() = c!5 -> c!7 -> Sender();
Receiver() = c?x -> got.x -> Receiver();

System() = Sender() ||| Receiver();`,
    proc: "System()",
    trace: "c.5, got.5, c.7, got.7, c.5",
  },
  {
    label: "buffered channel",
    model: `// A channel with buffer size 2: sends and receives are separate
// events, c!v and c?v, and the sender blocks when the buffer is full.
channel c 2;

Producer(i) = c!i -> Producer(i + 1);
Consumer() = c?x -> use.x -> Consumer();

System() = Producer(1) ||| Consumer();`,
    proc: "System()",
    trace: "c!1, c!2, c?1, use.1, c!3, c?2, c?3",
  },
  {
    label: "interrupt",
    model: `// P interrupt Q runs P until Q's first visible event fires,
// then control passes to Q for good.
Routine() = tick -> Routine();
Handler() = handle -> Skip;

System() = (Routine() interrupt exception -> Handler()); done -> Skip;`,
    proc: "System()",
    trace: "tick, tick, exception, handle, done, terminate",
  },
  {
    label: "alphabetised parallel",
    model: `// || synchronises on events in both alphabets; ||| does not.
// 'work' is in both alphabets below, so it is a barrier.
Left() = a -> work -> Left();
Right() = b -> work -> Right();

Lockstep() = Left() || Right();

// Data operations (events with programs) never synchronise, and
// neither do they count towards an alphabet.
var n = 0;
Counter() = work{n = n + 1;} -> Counter();
Counted() = Lockstep() || Counter();`,
    proc: "Counted()",
    trace: "a, b, work, work, a",
  },
];

/** Site-palette editor chrome. */
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13.5px", backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: "var(--font-geist-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": { padding: "16px 0", caretColor: "#1a1a1a" },
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
});

// URL-safe base64 for the sharing params.
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

function toDiagnostic(state: EditorState, message: string, loc?: Loc): Diagnostic[] {
  if (!loc) return [];
  const len = state.doc.length;
  const from = Math.min(loc.pos, len);
  const to = Math.min(Math.max(loc.end, from + 1), len);
  return [{ from, to: to > from ? to : Math.min(from + 1, len), severity: "error", message }];
}

const DEFAULT = examples[0];

export default function CspTool() {
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const traceRef = useRef<HTMLTextAreaElement>(null);

  const [trace, setTrace] = useState(DEFAULT.trace);
  const [proc, setProc] = useState(DEFAULT.proc);
  const [procTouched, setProcTouched] = useState(false);
  const [processes, setProcesses] = useState<string[]>([]);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Mirrors of the inputs for the debounced checker, which runs outside render.
  const traceState = useRef(trace);
  const procState = useRef(proc);
  const procTouchedRef = useRef(procTouched);
  useEffect(() => {
    traceState.current = trace;
    procState.current = proc;
    procTouchedRef.current = procTouched;
  }, [trace, proc, procTouched]);

  /** Parse, push squiggles, pick a default process, then check the trace. */
  const run = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const source = view.state.doc.toString();

    const syntax = checkSyntax(source);
    setProcesses(syntax.processes);
    let p = procState.current;
    if (!procTouchedRef.current && syntax.suggested && (!p || !syntax.processes.some((x) => x.split("(")[0] === p.split("(")[0]))) {
      p = syntax.suggested;
      setProc(p);
    }

    const r = checkTrace(source, p, traceState.current);
    setResult(r);
    const diags = syntax.error
      ? toDiagnostic(view.state, syntax.error.message, syntax.error.loc)
      : r.error
        ? toDiagnostic(view.state, r.error.message, r.error.loc)
        : [];
    view.dispatch(setDiagnostics(view.state, diags));
  }, []);

  const syncUrl = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const url = new URL(window.location.href);
    const source = view.state.doc.toString();
    const isDefault = source === DEFAULT.model && traceState.current === DEFAULT.trace && procState.current === DEFAULT.proc;
    if (isDefault) {
      url.searchParams.delete("m");
      url.searchParams.delete("t");
      url.searchParams.delete("p");
    } else {
      url.searchParams.set("m", encodeShare(source));
      url.searchParams.set("t", encodeShare(traceState.current));
      url.searchParams.set("p", encodeShare(procState.current));
    }
    window.history.replaceState(null, "", url);
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      run();
      syncUrl();
    }, 250);
  }, [run, syncUrl]);

  // Editor setup.
  useEffect(() => {
    if (!editorHost.current || viewRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const m = params.get("m");
    const initialDoc = (m && decodeShare(m)) || DEFAULT.model;
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
          cspLanguage(),
          lintGutter(),
          editorTheme,
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                run();
                return true;
              },
            },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) schedule();
          }),
        ],
      }),
    });
    viewRef.current = view;
    // Restore a shared trace/process from the URL, then run the first check.
    setTimeout(() => {
      const t = params.get("t");
      const p = params.get("p");
      const dt = t ? decodeShare(t) : null;
      const dp = p ? decodeShare(p) : null;
      if (dt !== null) setTrace(dt);
      if (dp !== null) {
        setProc(dp);
        setProcTouched(true);
      }
      run();
    }, 0);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [run, schedule]);

  // Re-check when the trace or process changes.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    schedule();
  }, [trace, proc, schedule]);

  const loadExample = useCallback((ex: Example) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ex.model } });
    setTrace(ex.trace);
    setProc(ex.proc);
    setProcTouched(false);
  }, []);

  const copyLink = useCallback(async () => {
    syncUrl();
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the address bar still has the link.
    }
  }, [syncUrl]);

  /** Extend the accepted prefix of the trace with an enabled event. */
  const appendEvent = useCallback(
    (name: string) => {
      if (!result) return;
      const prefix = result.steps.filter((s) => s.ok).map((s) => s.event);
      setTrace([...prefix, name].join(", "));
      traceRef.current?.focus();
    },
    [result],
  );

  const jumpTo = useCallback((loc: Loc) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: Math.min(loc.pos, view.state.doc.length) }, scrollIntoView: true });
    view.focus();
  }, []);

  const failed = result?.steps.find((s) => !s.ok);
  const hasVars = result?.states.some((s) => s.vars.length > 0 || s.chans.length > 0);

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      {/* Model editor */}
      <div className="flex-1 min-w-0 min-h-[40vh] lg:min-h-0 border-b lg:border-b-0 lg:border-r border-border relative">
        <div ref={editorHost} className="absolute inset-0" />
      </div>

      {/* Side panel */}
      <div className="lg:w-[26rem] xl:w-[30rem] shrink-0 flex flex-col min-h-0 overflow-y-auto">
        {/* Trace input */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs tracking-wider text-muted">TRACE</span>
            <span className="font-mono text-xs text-muted">checks as you type · ⌘↵</span>
          </div>
          <textarea
            ref={traceRef}
            value={trace}
            onChange={(e) => setTrace(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                run();
              }
            }}
            spellCheck={false}
            rows={3}
            placeholder="get.0.1, get.0.0, eat.0"
            className="mt-3 w-full resize-y border border-border bg-white/50 px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:border-muted transition-colors"
          />
          <div className="mt-3 flex items-center gap-3">
            <label htmlFor="proc" className="font-mono text-xs text-muted shrink-0">
              of process
            </label>
            <input
              id="proc"
              list="proc-list"
              value={proc}
              onChange={(e) => {
                setProc(e.target.value);
                setProcTouched(true);
              }}
              spellCheck={false}
              className="min-w-0 flex-1 border border-border bg-white/50 px-3 py-1.5 font-mono text-sm outline-none focus:border-muted transition-colors"
            />
            <datalist id="proc-list">
              {processes.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
        </div>

        {/* Verdict */}
        <div className="px-6 py-5 border-b border-border">
          <span className="font-mono text-xs tracking-wider text-muted">VERDICT</span>
          <div className="mt-3">
            {!result ? (
              <p className="font-mono text-sm text-muted">checking…</p>
            ) : result.error ? (
              <div className="space-y-3">
                {result.steps.length > 0 && <StepList steps={result.steps} />}
                <p className="font-mono text-sm leading-relaxed">
                  <span className="text-muted">error — </span>
                  {result.error.loc && (
                    <>
                      <button
                        className="text-muted hover:text-foreground transition-colors"
                        onClick={() => jumpTo(result.error!.loc!)}
                      >
                        {result.error.loc.line}:{result.error.loc.col}
                      </button>{" "}
                    </>
                  )}
                  {result.error.message}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="font-mono text-sm">
                  {result.accepted ? (
                    <span>
                      accepted
                      <span className="text-muted">
                        {" "}
                        — {result.steps.length} event{result.steps.length === 1 ? "" : "s"}
                        {result.configs > 1 && `, ${result.configs} possible states`}
                        {result.terminated && ", terminated"}
                        {result.deadlocked && ", now deadlocked"}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted">
                      rejected — <span className="text-foreground">{failed?.event}</span> is not enabled after{" "}
                      {failed?.index === 0 ? "the start" : `${failed?.index} event${failed?.index === 1 ? "" : "s"}`}
                    </span>
                  )}
                </p>

                {result.steps.length > 0 && <StepList steps={result.steps} />}

                {/* What can happen next */}
                <div>
                  <span className="font-mono text-xs tracking-wider text-muted">
                    {result.accepted ? "ENABLED NEXT" : "ENABLED INSTEAD"}
                  </span>
                  {result.enabled.length === 0 ? (
                    <p className="mt-2 font-mono text-xs text-muted">
                      {result.terminated ? "nothing — the process has terminated" : "nothing — deadlock"}
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {result.enabled.map((e) => (
                        <button
                          key={e}
                          onClick={() => appendEvent(e)}
                          title="append to the trace"
                          className="font-mono text-xs border border-border px-2 py-1 hover:border-muted transition-colors"
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* State */}
                {hasVars && (
                  <div>
                    <span className="font-mono text-xs tracking-wider text-muted">
                      {result.accepted ? "STATE" : "STATE BEFORE"}
                      {result.states.length > 1 && (
                        <span className="normal-case tracking-normal"> — {result.states.length} possibilities</span>
                      )}
                    </span>
                    <div className="mt-2 space-y-2">
                      {result.states.map((s, i) => (
                        <p key={i} className="font-mono text-xs leading-relaxed text-accent">
                          {s.vars.map((v) => `${v.name} = ${v.value}`).join(", ")}
                          {s.chans.length > 0 && s.vars.length > 0 && "; "}
                          {s.chans.map((c) => `${c.name}: [${c.items}]`).join(", ")}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Examples */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs tracking-wider text-muted">EXAMPLES</span>
            <button
              onClick={copyLink}
              className="font-mono text-xs text-muted hover:text-foreground transition-colors"
            >
              {copied ? "link copied" : "share this"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex.label}
                onClick={() => loadExample(ex)}
                className="font-mono text-xs text-muted border border-border px-2 py-1 hover:border-muted hover:text-foreground transition-colors"
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>

        {/* About */}
        <div className="px-6 py-5 border-b border-border">
          <span className="font-mono text-xs tracking-wider text-muted">WHAT THIS IS</span>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            CSP# is the input language of{" "}
            <a
              href="https://pat.comp.nus.edu.sg/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              PAT
            </a>
            , the Process Analysis Toolkit from NUS: Hoare&apos;s CSP with shared variables,
            channels, and C#-style program blocks attached to events. This is not the
            model checker. It is a runtime verifier: it takes one trace and decides
            whether the model can produce it, by running the language&apos;s{" "}
            <a
              href="https://pat.comp.nus.edu.sg/resources/public/pdf/PATManual.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-muted transition-colors"
            >
              operational semantics
            </a>{" "}
            forwards along the trace.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            Because CSP# is nondeterministic (internal choice, hidden events,
            interleaving), the checker follows every state the model could be in at
            once, the way you would simulate an NFA. A trace is accepted if that set
            never empties. Only the states the trace reaches are ever explored, so
            this stays cheap on models whose full state space would not be.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            The parser follows the grammar in the PAT 3.5 manual and the semantics
            follow its firing rules, including the parts that are easy to get wrong:
            data operations never synchronise, alphabets are computed once when a
            parallel composition is first reached, <code className="font-mono text-xs">[]</code>{" "}
            is resolved by any event while <code className="font-mono text-xs">[*]</code> needs
            a visible one, and <code className="font-mono text-xs">atomic</code> takes priority.
            Not covered: <code className="font-mono text-xs">#import</code> of C# libraries,
            user-defined types, and unbounded replication.
          </p>
        </div>

        {/* Trace syntax */}
        <div className="px-6 py-5">
          <span className="font-mono text-xs tracking-wider text-muted">TRACE FORMAT</span>
          <p className="mt-3 text-sm leading-relaxed text-accent">
            The same format as PAT&apos;s &ldquo;Simulate Trace&rdquo; box: events separated by
            commas, <code className="font-mono text-xs">e(5)</code> for five repetitions.
            Compound events are <code className="font-mono text-xs">get.0.1</code>; a
            synchronous handshake on channel c is{" "}
            <code className="font-mono text-xs">c.value</code>; buffered sends and
            receives are <code className="font-mono text-xs">c!value</code> and{" "}
            <code className="font-mono text-xs">c?value</code>; termination is{" "}
            <code className="font-mono text-xs">terminate</code>. Invisible steps
            (tau, hidden events, internal choice) are never written.
          </p>
        </div>
      </div>
    </div>
  );
}

function StepList({ steps }: { steps: CheckResult["steps"] }) {
  return (
    <ol className="border-t border-border divide-y divide-border">
      {steps.map((s) => (
        <li key={s.index} className="py-1.5 flex items-baseline gap-3 font-mono text-xs">
          <span className="text-muted w-6 shrink-0 text-right">{s.index + 1}</span>
          <span className={s.ok ? "" : "text-muted line-through"}>{s.event}</span>
          <span className="text-muted ml-auto shrink-0">
            {s.ok ? (s.configs > 1 ? `${s.configs} states` : "") : "✗"}
          </span>
        </li>
      ))}
    </ol>
  );
}
