"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorSelection, EditorState } from "@codemirror/state";
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
  EngineUnavailableError,
  hasAlgorithm,
  loadEngine,
  moduleName,
  requestStop,
  RuntimeTakenError,
  translate,
  type LoadPhase,
} from "@/lib/pluscal/engine";
import { examples, type Example } from "@/lib/pluscal/examples";
import { tlaLanguage } from "@/lib/pluscal/language";
import {
  interpret,
  ToolOutputReader,
  translatorErrors,
  type Location,
  type Report,
  type SourceError,
  type TraceState,
} from "@/lib/pluscal/tlcOutput";

const DEFAULT = examples[0];

type Phase = LoadPhase | "translating" | "checking";

const phaseLabel: Record<Phase, string> = {
  cheerpj: "starting the jvm…",
  jar: "loading tla2tools (~5 MB, cached)…",
  translating: "translating…",
  checking: "model checking…",
};

type Shown =
  | { kind: "translated"; messages: string[] }
  | { kind: "translate-failed"; errors: SourceError[] }
  | { kind: "run"; report: Report; status: number | null; stopped: boolean; elapsedMs: number }
  | { kind: "error"; message: string; stack?: string };

/** Site-palette editor chrome (as the Dafny tool's). */
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
  // Focused, the site's ::selection (light text on #1a1a1a) colours the text,
  // so the painted selection matches it; unfocused, it's a quiet tint.
  ".cm-selectionBackground": { backgroundColor: "rgba(26, 26, 26, 0.1)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: "#1a1a1a" },
  ".cm-cursor": { borderLeftColor: "#1a1a1a" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy #b91c1c 1px",
    textUnderlineOffset: "4px",
  },
  ".cm-gutter-lint": { width: "12px" },
  ".cm-gutter-lint .cm-gutterElement": { padding: "0", display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-lint-marker": { content: "none", width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "#b91c1c" },
  ".cm-lint-marker svg, .cm-lint-marker path": { display: "none" },
  ".cm-tooltip": {
    backgroundColor: "#fafaf8",
    border: "1px solid #e5e5e0",
    fontFamily: "var(--font-geist-mono)",
    fontSize: "12px",
    color: "#1a1a1a",
  },
  ".cm-diagnostic": { padding: "4px 8px", borderLeft: "none", whiteSpace: "pre-wrap" },
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

/** A TLC/SANY location (1-based, end column inclusive) as a document range. */
function toRange(state: EditorState, loc: Location): { from: number; to: number } | null {
  const doc = state.doc;
  if (loc.startLine < 1 || loc.startLine > doc.lines) return null;
  const start = doc.line(loc.startLine);
  const end = doc.line(Math.min(Math.max(loc.endLine, loc.startLine), doc.lines));
  const from = Math.min(start.from + Math.max(loc.startCol - 1, 0), start.to);
  let to = Math.min(end.from + Math.max(loc.endCol, 0), end.to);
  if (to <= from) to = Math.min(from + 1, doc.length);
  return { from, to };
}

function toDiagnostics(state: EditorState, errors: SourceError[], module: string | null): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const e of errors) {
    if (!e.location) continue;
    // Errors in other modules (e.g. a standard module) can't be shown inline.
    if (e.location.module && module && e.location.module !== module) continue;
    const r = toRange(state, e.location);
    if (r) out.push({ ...r, severity: "error", message: e.message, source: e.source });
  }
  return out;
}

const sourceName: Record<SourceError["source"], string> = {
  pcal: "translator",
  sany: "parser",
  tlc: "TLC",
};

/** TLC exit statuses (EC.ExitStatus) that mean "the model has a problem". */
function verdict(shown: Extract<Shown, { kind: "run" }>): { glyph: string; text: string } {
  const { report, status, stopped } = shown;
  if (stopped) return { glyph: "■", text: "stopped" };
  switch (report.outcome.kind) {
    case "running":
      return { glyph: "…", text: report.mode === "simulate" ? "simulating" : "checking" };
    case "success":
      return { glyph: "✓", text: report.mode === "simulate" ? "no error found in the simulated behaviors" : "no errors: every reachable state checked" };
    case "invariant":
      return { glyph: "✗", text: `invariant ${report.outcome.name} violated` };
    case "action-property":
      return { glyph: "✗", text: `action property ${report.outcome.name} violated` };
    case "temporal":
      return { glyph: "✗", text: `temporal property ${report.outcome.name} violated` };
    case "deadlock":
      return { glyph: "✗", text: "deadlock reached" };
    case "assumption":
      return { glyph: "✗", text: "an ASSUME is false" };
    case "no-initial-states":
      return { glyph: "✗", text: "no state satisfies the initial predicate" };
    case "parse-error":
      return { glyph: "✗", text: "the spec didn't parse" };
    case "error":
      return { glyph: "✗", text: "TLC stopped with an error" };
    case "finished":
      return { glyph: status === 0 ? "✓" : "✗", text: status === 0 ? "finished" : `TLC exited with status ${status}` };
  }
}

const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));

function StateCard({
  state,
  prev,
  selected,
  onSelect,
  nameWidth,
}: {
  state: TraceState;
  prev: TraceState | null;
  /** In ch, so the value column lines up across every state. */
  nameWidth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const before = new Map(prev?.vars.map((v) => [v.name, v.value]) ?? []);
  return (
    <li className={`border-l-2 pl-3 py-2 ${selected ? "border-foreground" : "border-border"}`}>
      <button onClick={onSelect} className="w-full text-left font-mono text-xs flex items-baseline gap-2 group">
        <span className="text-muted tabular-nums">{state.index}</span>
        <span className="group-hover:underline underline-offset-2 break-all">{state.action}</span>
        {state.location && (
          <span className="ml-auto text-muted whitespace-nowrap">
            {state.location.startLine}:{state.location.startCol}
          </span>
        )}
      </button>
      <table className="mt-1.5 w-full table-fixed font-mono text-xs">
        <colgroup>
          <col style={{ width: `${nameWidth}ch` }} />
          <col />
        </colgroup>
        <tbody>
          {state.vars.map((v) => {
            const changed = prev !== null && before.get(v.name) !== v.value;
            return (
              <tr key={v.name} className="align-top">
                <td className={`pr-3 py-0.5 whitespace-nowrap overflow-hidden text-ellipsis ${changed ? "text-foreground font-semibold" : "text-muted"}`}>
                  {changed ? "▸ " : ""}
                  {v.name}
                </td>
                <td className={`py-0.5 whitespace-pre-wrap break-all ${changed ? "text-foreground" : "text-muted"}`}>{v.value}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </li>
  );
}

let engineReady = false;

export default function PlusCalTool() {
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [cfg, setCfg] = useState(DEFAULT.cfg);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [booting, setBooting] = useState<LoadPhase | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [simulate, setSimulate] = useState(false);
  const [checkDeadlock, setCheckDeadlock] = useState(true);
  const [simTraces, setSimTraces] = useState(1000);
  const [simDepth, setSimDepth] = useState(100);
  const [extraArgs, setExtraArgs] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const fail = useCallback((e: unknown) => {
    if (e instanceof RuntimeTakenError) {
      window.location.reload();
      return;
    }
    setShown({
      kind: "error",
      message:
        e instanceof EngineUnavailableError
          ? `couldn't load the model checker — ${e.message}`
          : e instanceof Error
            ? e.message
            : "something went wrong",
    });
  }, []);

  const ensureEngine = useCallback(async () => {
    if (engineReady) return;
    await loadEngine((p) => setPhase(p));
    engineReady = true;
  }, []);

  const showDiagnostics = useCallback((errors: SourceError[], source: string) => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() !== source) return;
    view.dispatch(setDiagnostics(view.state, toDiagnostics(view.state, errors, moduleName(source))));
  }, []);

  const syncUrl = useCallback((source: string, model: string) => {
    const url = new URL(window.location.href);
    if (source === DEFAULT.tla && model === DEFAULT.cfg) {
      url.searchParams.delete("spec");
      url.searchParams.delete("cfg");
    } else {
      url.searchParams.set("spec", encodeShare(source));
      url.searchParams.set("cfg", encodeShare(model));
    }
    window.history.replaceState(null, "", url);
  }, []);

  /**
   * Runs the translator and writes its output back into the editor, as the
   * Toolbox does: the module is rewritten in place (one undoable change).
   * Returns the translated module, or null if translation failed.
   */
  const runTranslate = useCallback(async (): Promise<string | null> => {
    const view = viewRef.current;
    if (!view) return null;
    const source = view.state.doc.toString();
    const name = moduleName(source);
    if (!name) {
      setShown({ kind: "error", message: "the module needs a header line: ---- MODULE Name ----" });
      return null;
    }
    setPhase("translating");
    const out = await translate(name, source);
    if (!out.ok) {
      setShown({ kind: "error", message: out.failure.error, stack: out.failure.stack });
      return null;
    }
    if (out.value.status !== 0 || out.value.tla === null) {
      const errors = translatorErrors(out.value.messages);
      setShown({ kind: "translate-failed", errors });
      showDiagnostics(errors, source);
      return null;
    }
    const tla = out.value.tla;
    if (view.state.doc.toString() === source && tla !== source) {
      const head = Math.min(view.state.selection.main.head, tla.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: tla },
        selection: EditorSelection.cursor(head),
      });
    }
    if (cfgRef.current.trim() === "" && out.value.cfg) setCfg(out.value.cfg);
    showDiagnostics([], view.state.doc.toString());
    return view.state.doc.toString();
  }, [showDiagnostics]);

  const onTranslate = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await ensureEngine();
      const view = viewRef.current;
      if (view && !hasAlgorithm(view.state.doc.toString())) {
        setShown({ kind: "error", message: "there's no PlusCal algorithm in this module — write one inside (* --algorithm Name ... *)" });
        return;
      }
      const tla = await runTranslate();
      if (tla !== null) setShown({ kind: "translated", messages: [] });
    } catch (e) {
      fail(e);
    } finally {
      busy.current = false;
      setPhase(null);
    }
  }, [ensureEngine, runTranslate, fail]);

  const onCheck = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSelected(null);
    try {
      await ensureEngine();
      const view = viewRef.current;
      if (!view) return;
      let source = view.state.doc.toString();
      if (hasAlgorithm(source)) {
        const tla = await runTranslate();
        if (tla === null) return;
        source = tla;
      }
      const name = moduleName(source);
      if (!name) {
        setShown({ kind: "error", message: "the module needs a header line: ---- MODULE Name ----" });
        return;
      }
      const model = cfgRef.current;
      syncUrl(source, model);

      const args = ["-tool", "-workers", "1", "-noGenerateSpecTE"];
      if (!checkDeadlock) args.push("-deadlock");
      if (simulate) args.push("-simulate", `num=${Math.max(1, Math.round(simTraces))}`, "-depth", String(Math.max(1, Math.round(simDepth))));
      args.push(...extraArgs.split(/\s+/).filter(Boolean));

      const reader = new ToolOutputReader();
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const refresh = () => {
        timer = null;
        setShown({ kind: "run", report: interpret(reader.items), status: null, stopped: false, elapsedMs: performance.now() - started });
      };
      setShown({ kind: "run", report: interpret([]), status: null, stopped: false, elapsedMs: 0 });
      setPhase("checking");
      const tick = setInterval(() => setElapsed(performance.now() - started), 250);
      setElapsed(0);
      let out;
      try {
        out = await check(name, source, model, args, (line) => {
          reader.push(line);
          timer ??= setTimeout(refresh, 150);
        });
      } finally {
        clearInterval(tick);
        if (timer) clearTimeout(timer);
      }
      if (!out.ok) {
        setShown({ kind: "error", message: out.failure.error, stack: out.failure.stack });
        return;
      }
      const report = interpret(reader.items);
      setShown({ kind: "run", report, status: out.value.status, stopped: out.value.stopped, elapsedMs: performance.now() - started });
      showDiagnostics(report.errors, source);
      if (out.value.status === -1) {
        setShown({ kind: "error", message: `TLC rejected the arguments: ${args.join(" ")}\n\n${report.console.join("\n")}` });
      }
    } catch (e) {
      fail(e);
    } finally {
      busy.current = false;
      setPhase(null);
    }
  }, [ensureEngine, runTranslate, syncUrl, checkDeadlock, simulate, simTraces, simDepth, extraArgs, showDiagnostics, fail]);

  const onCheckRef = useRef(onCheck);
  onCheckRef.current = onCheck;

  // Editor setup.
  useEffect(() => {
    if (!editorHost.current || viewRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const sharedSpec = params.get("spec");
    const sharedCfg = params.get("cfg");
    const initialDoc = (sharedSpec && decodeShare(sharedSpec)) || DEFAULT.tla;
    if (sharedSpec && sharedCfg !== null) {
      const c = decodeShare(sharedCfg);
      if (c !== null) setCfg(c);
    }
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
          tlaLanguage(),
          lintGutter(),
          editorTheme,
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                void onCheckRef.current();
                return true;
              },
            },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Start the JVM in the background, so the first check doesn't wait for it.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        await loadEngine((p) => !cancelled && setBooting(p));
        engineReady = true;
      } catch (e) {
        if (e instanceof RuntimeTakenError) window.location.reload();
        // Otherwise a real run will report it.
      } finally {
        if (!cancelled) setBooting(null);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  const jumpTo = useCallback((loc: Location | null) => {
    const view = viewRef.current;
    if (!view || !loc) return;
    const name = moduleName(view.state.doc.toString());
    if (loc.module && name && loc.module !== name) return;
    const r = toRange(view.state, loc);
    if (!r) return;
    view.dispatch({ selection: EditorSelection.range(r.from, r.to), effects: EditorView.scrollIntoView(r.from, { y: "center" }) });
    view.focus();
  }, []);

  const loadExample = useCallback((ex: Example) => {
    const view = viewRef.current;
    if (!view || busy.current) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ex.tla } });
    view.dispatch(setDiagnostics(view.state, []));
    setCfg(ex.cfg);
    setShown(null);
    setSelected(null);
    view.focus();
  }, []);

  const copyLink = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    syncUrl(view.state.doc.toString(), cfgRef.current);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the address bar still has the link.
    }
  }, [syncUrl]);

  const running = phase !== null;
  const status = phase ? phaseLabel[phase] : booting ? phaseLabel[booting] : "";
  const label = "font-mono text-xs tracking-wider text-muted";
  const chip = "font-mono text-xs border border-border px-2 py-1 text-muted hover:border-muted hover:text-foreground transition-colors";
  const button =
    "font-mono text-xs border border-border px-3 py-1.5 hover:border-muted hover:text-foreground text-muted transition-colors disabled:opacity-40 disabled:hover:border-border";
  const input = "mt-1 w-full border border-border bg-white/50 px-3 py-2 font-mono text-sm outline-none focus:border-muted";

  const run = shown?.kind === "run" ? shown : null;
  const v = run ? verdict(run) : null;
  const trace = run?.report.trace ?? null;

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      {/* Editor */}
      <div className="flex-1 min-w-0 min-h-[55vh] lg:min-h-0 border-b lg:border-b-0 lg:border-r border-border relative">
        <div ref={editorHost} className="absolute inset-0" data-testid="pluscal-editor" />
      </div>

      {/* Side panel */}
      <div className="lg:w-[28rem] xl:w-[34rem] shrink-0 flex flex-col min-h-0 overflow-y-auto">
        {/* Run */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={onCheck} disabled={running} className={button} data-testid="pluscal-check">
              {simulate ? "simulate →" : "check →"}
            </button>
            {phase === "checking" ? (
              <button onClick={requestStop} className={button} data-testid="pluscal-stop">
                ■ stop
              </button>
            ) : (
              <button onClick={onTranslate} disabled={running} className={button}>
                translate
              </button>
            )}
            <span className="font-mono text-xs text-muted">⌘↵</span>
            <button onClick={copyLink} className="ml-auto font-mono text-xs text-muted hover:text-foreground transition-colors">
              {copied ? "copied" : "share link"}
            </button>
          </div>
          {status && (
            <p className="mt-3 font-mono text-xs text-muted" data-testid="pluscal-status">
              {status}
              {phase === "checking" && ` ${(elapsed / 1000).toFixed(1)}s`}
            </p>
          )}

          <label htmlFor="pluscal-cfg" className={`${label} block mt-5`}>
            MODEL <span className="tracking-normal">(.cfg)</span>
          </label>
          <textarea
            id="pluscal-cfg"
            value={cfg}
            onChange={(e) => setCfg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void onCheck();
              }
            }}
            spellCheck={false}
            rows={Math.min(Math.max(cfg.split("\n").length, 3), 10)}
            placeholder={"SPECIFICATION Spec\nINVARIANT TypeOK"}
            className="mt-2 w-full resize-y border border-border bg-white/50 px-4 py-3 font-mono text-sm leading-relaxed outline-none focus:border-muted transition-colors placeholder:text-muted/60"
          />

          <button
            onClick={() => setShowOptions((o) => !o)}
            className="mt-2 font-mono text-xs text-muted hover:text-foreground transition-colors"
          >
            {showOptions ? "− options" : "+ options"}
          </button>
          {showOptions && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <label className="col-span-2 flex items-center gap-2 font-mono text-xs text-muted">
                <input type="checkbox" checked={checkDeadlock} onChange={(e) => setCheckDeadlock(e.target.checked)} />
                check for deadlock
              </label>
              <label className="col-span-2 flex items-center gap-2 font-mono text-xs text-muted">
                <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
                simulate random behaviors instead of exhaustive search
              </label>
              {simulate && (
                <>
                  <div>
                    <label htmlFor="pluscal-num" className="font-mono text-xs text-muted">
                      behaviors
                    </label>
                    <input id="pluscal-num" type="number" min={1} value={simTraces} onChange={(e) => setSimTraces(Number(e.target.value))} className={input} />
                  </div>
                  <div>
                    <label htmlFor="pluscal-depth" className="font-mono text-xs text-muted">
                      max depth
                    </label>
                    <input id="pluscal-depth" type="number" min={1} value={simDepth} onChange={(e) => setSimDepth(Number(e.target.value))} className={input} />
                  </div>
                </>
              )}
              <div className="col-span-2">
                <label htmlFor="pluscal-args" className="font-mono text-xs text-muted">
                  more TLC arguments
                </label>
                <input
                  id="pluscal-args"
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  spellCheck={false}
                  placeholder="-coverage 1 -maxSetSize 100000 -seed 7"
                  className={`${input} placeholder:text-muted/60`}
                />
              </div>
            </div>
          )}
        </div>

        {/* Result */}
        <div className="px-6 py-5 border-b border-border" data-testid="pluscal-result">
          <span className={label}>RESULT</span>
          <div className="mt-3">
            {shown === null ? (
              <p className="font-mono text-sm text-muted">nothing checked yet</p>
            ) : shown.kind === "translated" ? (
              <p className="font-mono text-sm">
                translated <span className="text-muted">— the TLA+ is between BEGIN and END TRANSLATION</span>
              </p>
            ) : shown.kind === "translate-failed" ? (
              <div>
                <p className="font-mono text-sm" data-testid="pluscal-verdict">
                  ✗ <span className="text-muted">the algorithm didn&apos;t translate</span>
                </p>
                <ErrorList errors={shown.errors} onJump={jumpTo} />
              </div>
            ) : shown.kind === "error" ? (
              <div>
                <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{shown.message}</pre>
                {shown.stack && (
                  <details className="mt-2">
                    <summary className="font-mono text-xs text-muted cursor-pointer">stack</summary>
                    <pre className="mt-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted">{shown.stack}</pre>
                  </details>
                )}
              </div>
            ) : (
              run &&
              v && (
                <div>
                  <p className="font-mono text-sm" data-testid="pluscal-verdict">
                    {v.glyph} <span className={run.report.outcome.kind === "success" ? "" : "text-muted"}>{v.text}</span>
                  </p>
                  <dl className="mt-3 grid grid-cols-4 gap-2 font-mono text-xs" data-testid="pluscal-stats">
                    {[
                      ["distinct", fmt(run.report.stats.distinct)],
                      ["generated", fmt(run.report.stats.generated)],
                      ["depth", fmt(run.report.stats.depth)],
                      ["time", run.status === null ? `${(run.elapsedMs / 1000).toFixed(1)}s` : (run.report.durationText ?? `${(run.elapsedMs / 1000).toFixed(1)}s`)],
                    ].map(([k, val]) => (
                      <div key={k}>
                        <dt className="text-muted">{k}</dt>
                        <dd className="tabular-nums">{val}</dd>
                      </div>
                    ))}
                  </dl>

                  {run.report.errors.length > 0 && <ErrorList errors={run.report.errors} onJump={jumpTo} />}

                  {run.report.warnings.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {run.report.warnings.map((w, i) => (
                        <li key={i} className="font-mono text-xs text-muted whitespace-pre-wrap">
                          ⚠ {w}
                        </li>
                      ))}
                    </ul>
                  )}

                  {trace && trace.states.length > 0 && (
                    <div className="mt-5" data-testid="pluscal-trace">
                      <span className={label}>
                        {run.report.outcome.kind === "temporal" ? "COUNTEREXAMPLE" : run.report.outcome.kind === "error" ? "BEHAVIOR UP TO THE ERROR" : "ERROR TRACE"}{" "}
                        <span className="tracking-normal">· {trace.states.length} states</span>
                      </span>
                      <ol className="mt-2 space-y-1">
                        {trace.states.map((s, i) => (
                          <StateCard
                            key={i}
                            state={s}
                            prev={i > 0 ? trace.states[i - 1] : null}
                            nameWidth={Math.min(24, Math.max(...trace.states.flatMap((t) => t.vars.map((x) => x.name.length))) + 4)}
                            selected={selected === i}
                            onSelect={() => {
                              setSelected(i);
                              jumpTo(s.location);
                            }}
                          />
                        ))}
                      </ol>
                      {trace.ending?.kind === "stuttering" && (
                        <p className="mt-2 font-mono text-xs text-muted">⋯ then stutters forever: no step is ever taken again</p>
                      )}
                      {trace.ending?.kind === "back-to" && (
                        <p className="mt-2 font-mono text-xs text-muted">
                          ↺ then {trace.ending.action} goes back to state {trace.ending.index}, and the loop repeats forever
                        </p>
                      )}
                    </div>
                  )}

                  <details className="mt-5">
                    <summary className="font-mono text-xs text-muted cursor-pointer">TLC output</summary>
                    <pre className="mt-2 max-h-96 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted" data-testid="pluscal-console">
                      {run.report.console.join("\n")}
                    </pre>
                  </details>
                </div>
              )
            )}
          </div>
        </div>

        {/* Examples */}
        <div className="px-6 py-5 border-b border-border">
          <span className={label}>EXAMPLES</span>
          <ul className="mt-3 space-y-2">
            {examples.map((ex) => (
              <li key={ex.id}>
                <button onClick={() => loadExample(ex)} className={chip} data-testid={`pluscal-example-${ex.id}`}>
                  {ex.label}
                </button>
                <span className="ml-2 text-xs text-muted">{ex.blurb}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* About */}
        <div className="px-6 py-5">
          <span className={label}>ABOUT</span>
          <p className="mt-3 text-xs text-muted leading-relaxed">
            This is the TLA+ project&apos;s own{" "}
            <a
              href="https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              tla2tools.jar
            </a>{" "}
            — the PlusCal translator, the SANY parser and the TLC model checker — with the{" "}
            <a
              href="https://github.com/tlaplus/CommunityModules"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              Community Modules
            </a>
            , unmodified, on{" "}
            <a
              href="https://cheerpj.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              CheerpJ
            </a>
            , a JVM in WebAssembly. Each run starts TLC fresh, exactly as{" "}
            <code>java tlc2.TLC</code> would. Nothing leaves your machine. It runs one worker and is slower than a native
            JVM — fine for the small models you&apos;d write while thinking, not for a cluster&apos;s worth of states.{" "}
            <a
              href="https://github.com/kavishsathia/kavishsathia/tree/main/wasm-src/pluscal"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              How it&apos;s built
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function ErrorList({ errors, onJump }: { errors: SourceError[]; onJump: (loc: Location | null) => void }) {
  return (
    <ul className="mt-3 space-y-3" data-testid="pluscal-errors">
      {errors.map((e, i) => (
        <li key={i}>
          <div className="font-mono text-xs text-muted flex gap-2">
            <span>{sourceName[e.source]}</span>
            {e.location && (
              <button onClick={() => onJump(e.location)} className="underline underline-offset-2 hover:text-foreground">
                {e.location.module ? `${e.location.module} ` : "line "}
                {e.location.startLine}:{e.location.startCol}
              </button>
            )}
          </div>
          <pre className="mt-1 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{e.message}</pre>
        </li>
      ))}
    </ul>
  );
}
