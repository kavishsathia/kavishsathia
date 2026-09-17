"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { verilog } from "codemirror-lang-verilog";
import { FPGA_EXAMPLES, type FpgaExample } from "@/lib/fpga/examples";
import { runSimulation, type SimulationStage } from "@/lib/fpga/engine";
import { formatLogic, formatTime, parseVcdReplay, valueAt } from "@/lib/fpga/replay";
import type { SimulationDiagnostic, WaveData } from "@/lib/fpga/types";
import WaveformViewer from "./WaveformViewer";

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono)", lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { padding: "10px 0", caretColor: "#1a1a1a" },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#c9c9c2", border: "none", paddingLeft: "4px" },
  ".cm-activeLine": { backgroundColor: "rgba(229,229,224,.35)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#6b6b6b" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(26,26,26,.08)" },
  ".cm-cursor": { borderLeftColor: "#1a1a1a" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #b91c1c 1px", textUnderlineOffset: "3px" },
  ".cm-tooltip": { backgroundColor: "#fafaf8", border: "1px solid #e5e5e0", fontFamily: "var(--font-geist-mono)", fontSize: "11px" },
});

type ViewerState = "empty" | "running" | "failed" | "no-dump" | "ready";

function encoded(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decoded(value: string) {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch { return null; }
}

function inlineDiagnostics(view: EditorView | null, diagnostics: SimulationDiagnostic[], file: "design.v" | "testbench.v") {
  if (!view) return;
  const converted: Diagnostic[] = diagnostics.filter((item) => item.file === file && item.line).map((item) => {
    const line = view.state.doc.line(Math.min(item.line!, view.state.doc.lines));
    return { from: line.from, to: Math.max(line.from + 1, line.to), severity: item.severity, message: item.message, source: "Icarus Verilog" };
  });
  view.dispatch(setDiagnostics(view.state, converted));
}

export default function FpgaTool() {
  const designHost = useRef<HTMLDivElement>(null);
  const testbenchHost = useRef<HTMLDivElement>(null);
  const designView = useRef<EditorView | null>(null);
  const testbenchView = useRef<EditorView | null>(null);
  const activeRun = useRef<{ stop: () => void } | null>(null);
  const vcdRef = useRef<string | null>(null);
  const currentExample = useRef(FPGA_EXAMPLES[0]);

  const [wave, setWave] = useState<WaveData | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState>("empty");
  const [stage, setStage] = useState<SimulationStage | null>(null);
  const [cursor, setCursor] = useState(0);
  const [diagnostics, setDiagnosticState] = useState<SimulationDiagnostic[]>([]);
  const [consoleOutput, setConsoleOutput] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = useCallback(() => {
    activeRun.current?.stop();
    activeRun.current = null;
    vcdRef.current = null;
    setWave(null);
    setViewerState("empty");
    setStage(null);
    setDiagnosticState([]);
    setConsoleOutput("");
    setElapsed(null);
  }, []);
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;

  const run = useCallback(async () => {
    const design = designView.current?.state.doc.toString() ?? "";
    const testbench = testbenchView.current?.state.doc.toString() ?? "";
    if (!design.trim() || !testbench.trim()) return;
    activeRun.current?.stop();
    setWave(null);
    setCursor(0);
    setViewerState("running");
    setDiagnosticState([]);
    setConsoleOutput("");
    setElapsed(null);
    inlineDiagnostics(designView.current, [], "design.v");
    inlineDiagnostics(testbenchView.current, [], "testbench.v");
    const operation = runSimulation(design, testbench, "2012", setStage);
    activeRun.current = operation;
    try {
      const result = await operation.promise;
      activeRun.current = null;
      setDiagnosticState(result.diagnostics);
      setConsoleOutput(result.stdout);
      setElapsed(result.elapsedMs);
      inlineDiagnostics(designView.current, result.diagnostics, "design.v");
      inlineDiagnostics(testbenchView.current, result.diagnostics, "testbench.v");
      if (result.diagnostics.some((item) => item.severity === "error") || !result.vcd) {
        setViewerState(result.diagnostics.length ? "failed" : "no-dump");
        return;
      }
      const parsed = parseVcdReplay(result.vcd);
      vcdRef.current = result.vcd;
      setWave(parsed);
      setCursor(0);
      setViewerState("ready");
    } catch (error) {
      activeRun.current = null;
      const message = error instanceof Error ? error.message : "Simulation failed.";
      setDiagnosticState([{ file: "engine", message, severity: "error" }]);
      setConsoleOutput(message);
      setViewerState("failed");
    } finally { setStage(null); }
  }, []);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!designHost.current || !testbenchHost.current) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const initialDesign = (params.get("d") && decoded(params.get("d")!)) || FPGA_EXAMPLES[0].design;
    const initialTestbench = (params.get("t") && decoded(params.get("t")!)) || FPGA_EXAMPLES[0].testbench;
    const makeEditor = (parent: HTMLElement, doc: string) => new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [lineNumbers(), history(), drawSelection(), indentUnit.of("  "), indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(), highlightActiveLineGutter(), verilog(), lintGutter(), editorTheme, keymap.of([{ key: "Mod-Enter", run: () => { void runRef.current(); return true; } }, indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]), EditorView.updateListener.of((update) => { if (update.docChanged) invalidateRef.current(); })] }),
    });
    designView.current = makeEditor(designHost.current, initialDesign);
    testbenchView.current = makeEditor(testbenchHost.current, initialTestbench);
    return () => { designView.current?.destroy(); testbenchView.current?.destroy(); activeRun.current?.stop(); };
  }, []);

  const loadExample = useCallback((example: FpgaExample) => {
    currentExample.current = example;
    for (const [view, source] of [[designView.current, example.design], [testbenchView.current, example.testbench]] as const) {
      if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
    }
    designView.current?.focus();
  }, []);

  const copyShare = useCallback(async () => {
    const design = designView.current?.state.doc.toString() ?? "";
    const testbench = testbenchView.current?.state.doc.toString() ?? "";
    window.history.replaceState(null, "", `#d=${encoded(design)}&t=${encoded(testbench)}`);
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); window.setTimeout(() => setCopied(false), 1200); } catch {}
  }, []);

  const mappedSignals = currentExample.current.outputs.map((path) => wave?.signals.find((signal) => `${signal.path.join(".")}.${signal.name}` === path)).filter(Boolean);
  const nextClockEdge = () => {
    const clock = wave?.signals.find((signal) => signal.name === "clk");
    const next = clock?.transitions.find(([time]) => time > cursor)?.[0];
    if (next !== undefined) setCursor(next);
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto lg:grid lg:grid-rows-[minmax(17rem,38%)_minmax(22rem,1fr)] lg:overflow-hidden" data-testid="fpga-workspace">
      <div className="grid min-h-fit shrink-0 grid-cols-1 border-b border-border lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_17rem]">
        <EditorPane title="DESIGN.V" host={designHost} />
        <EditorPane title="TESTBENCH.V" host={testbenchHost} border />
        <aside className="flex min-h-[15rem] flex-col overflow-y-auto border-t border-border bg-background lg:min-h-0 lg:border-l lg:border-t-0">
          <div className="border-b border-border p-3">
            <div className="flex items-center gap-2">
              <button data-testid="run-simulation" onClick={() => void run()} disabled={viewerState === "running"} className="border border-foreground bg-foreground px-3 py-1.5 font-mono text-xs text-background disabled:opacity-40">run ⌘↵</button>
              <button onClick={() => activeRun.current?.stop()} disabled={viewerState !== "running"} className="border border-border px-3 py-1.5 font-mono text-xs text-muted disabled:opacity-30">stop</button>
              <span className="ml-auto font-mono text-[10px] text-muted">{stage ? `${stage}…` : viewerState === "ready" ? `${elapsed?.toFixed(0)} ms` : "idle"}</span>
            </div>
            <select aria-label="Example" onChange={(event) => loadExample(FPGA_EXAMPLES[Number(event.target.value)])} className="mt-3 w-full border border-border bg-white/60 px-2 py-1.5 font-mono text-[11px] outline-none">
              {FPGA_EXAMPLES.map((example, index) => <option key={example.name} value={index}>{example.label}</option>)}
            </select>
            <button onClick={() => void copyShare()} className="mt-2 font-mono text-[10px] text-muted hover:text-foreground">{copied ? "link copied" : "share source"}</button>
          </div>
          <div className="border-b border-border p-3">
            <div className="flex items-center justify-between"><span className="font-mono text-[10px] tracking-wider text-muted">BOARD / REPLAY</span><span className="font-mono text-[9px] text-muted">batch</span></div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">Controls scrub a completed testbench run; they do not drive a live FPGA.</p>
            <div className="mt-3 flex gap-2"><button onClick={() => setCursor(0)} disabled={!wave} className="border border-border px-2 py-1 font-mono text-[10px] disabled:opacity-30">reset ↺</button><button onClick={nextClockEdge} disabled={!wave} className="border border-border px-2 py-1 font-mono text-[10px] disabled:opacity-30">clock edge ›</button></div>
            <div className="mt-3 grid grid-cols-4 gap-2" aria-label="Mapped LEDs">
              {Array.from({ length: 4 }, (_, index) => {
                const signal = mappedSignals[0];
                const value = signal ? valueAt(signal, cursor) : "0000";
                const on = value.at(-(index + 1)) === "1";
                return <div key={index} className="text-center"><span className={`mx-auto block h-3 w-3 rounded-full border ${on ? "border-[#24563a] bg-[#24563a]" : "border-border bg-white"}`} /><span className="font-mono text-[9px] text-muted">L{index}</span></div>;
              })}
            </div>
            <div className="mt-3 space-y-1 font-mono text-[9px] text-muted">{currentExample.current.outputs.map((output) => <p key={output}>LED ← {output}</p>)}<p>RESET ← testbench reset</p><p>CLOCK ← testbench clk</p></div>
          </div>
          <div className="min-h-24 flex-1 p-3">
            <span className="font-mono text-[10px] tracking-wider text-muted">DIAGNOSTICS</span>
            {diagnostics.length ? <ul className="mt-2 space-y-2" data-testid="diagnostics">{diagnostics.map((item, index) => <li key={index} className="font-mono text-[10px] leading-relaxed"><span className="text-muted">{item.file}{item.line ? `:${item.line}` : ""}</span> {item.message}</li>)}</ul> : <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[9px] leading-relaxed text-muted">{consoleOutput || "No diagnostics."}</pre>}
          </div>
        </aside>
      </div>
      <WaveformViewer vcd={vcdRef.current} state={viewerState} onDownload={() => {
        if (!vcdRef.current) return;
        const url = URL.createObjectURL(new Blob([vcdRef.current], { type: "text/plain" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "dump.vcd"; anchor.click(); URL.revokeObjectURL(url);
      }} />
      {wave && <output className="sr-only" data-testid="simulation-result">{wave.signals.length} signals, cursor {formatTime(cursor, wave.timescale)}, {mappedSignals[0] ? formatLogic(valueAt(mappedSignals[0], cursor)) : "unmapped"}</output>}
    </main>
  );
}

function EditorPane({ title, host, border = false }: { title: string; host: React.RefObject<HTMLDivElement | null>; border?: boolean }) {
  return <section className={`relative min-h-[17rem] overflow-hidden ${border ? "border-t border-border lg:border-l lg:border-t-0" : ""}`} aria-label={title}>
    <div className="absolute inset-x-0 top-0 z-10 flex h-8 items-center border-b border-border bg-background/95 px-3 font-mono text-[10px] tracking-wider text-muted">{title}</div>
    <div ref={host} className="absolute inset-x-0 bottom-0 top-8" />
  </section>;
}
