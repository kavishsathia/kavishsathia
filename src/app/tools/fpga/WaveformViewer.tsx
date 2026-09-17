"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  vcd: string | null;
  state: "empty" | "running" | "failed" | "no-dump" | "ready";
  onDownload: () => void;
};

type SurferMessage = { command: "LoadUrl"; url: string } | { command: "InjectMessage"; message: string };

/**
 * Embeds the upstream Surfer WASM application. Surfer and its Wellen backend own
 * VCD parsing and waveform rendering; this component only transfers the VCD to
 * the same-origin iframe and asks Surfer to show the testbench hierarchy.
 */
export default function WaveformViewer({ vcd, state, onDownload }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const vcdUrlRef = useRef<string | null>(null);
  const [loadedVcd, setLoadedVcd] = useState<string | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const post = (message: SurferMessage) => frame.contentWindow?.postMessage(message, window.location.origin);
    const load = () => {
      if (vcdUrlRef.current) URL.revokeObjectURL(vcdUrlRef.current);
      if (!vcd) return;
      const url = URL.createObjectURL(new Blob([vcd], { type: "text/plain" }));
      vcdUrlRef.current = url;
      post({ command: "LoadUrl", url });
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      if (event.data?.command === "surfer-ready") load();
      if (event.data?.command === "surfer-waveform-loaded") {
        // Wellen has finished building the hierarchy. Populate the view with
        // the testbench scope; users can then refine the selection in Surfer.
        post({
          command: "InjectMessage",
          message: JSON.stringify({ AddScope: [{ strs: ["tb"], id: "None" }, true] }),
        });
        setLoadedVcd(vcd);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (vcdUrlRef.current) URL.revokeObjectURL(vcdUrlRef.current);
      vcdUrlRef.current = null;
    };
  }, [vcd]);

  const emptyMessage = state === "running"
    ? "Icarus is compiling and simulating…"
    : state === "failed"
      ? "Simulation failed. Fix the diagnostic and run again."
      : state === "no-dump"
        ? "Simulation completed without a VCD. Add $dumpfile and $dumpvars to the testbench."
        : "Run the example to generate a waveform.";

  return <section className="flex min-h-[30rem] flex-1 flex-col bg-[#fdfdfb] lg:min-h-0" aria-label="Waveform viewer">
    <div className="flex min-h-10 items-center gap-3 border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted">
      <span className="tracking-wider">WAVEFORM / SURFER</span>
      <span className="hidden sm:inline">Wellen VCD backend · scroll to zoom · drag to pan</span>
      <button onClick={onDownload} disabled={!vcd} className="ml-auto border border-border px-2 py-1 disabled:opacity-30">VCD ↓</button>
    </div>
    {vcd ? <iframe
      ref={frameRef}
      src="/fpga/surfer/index.html#dev"
      title="Surfer digital waveform viewer"
      className="min-h-[28rem] w-full flex-1 border-0 bg-[#404040]"
      data-testid="surfer-viewer"
    /> : <div className="flex flex-1 items-center justify-center px-8 text-center font-mono text-xs text-muted">{emptyMessage}</div>}
    {vcd && loadedVcd === vcd && <span className="sr-only" data-testid="surfer-waveform-loaded">Surfer parsed the simulation VCD</span>}
  </section>;
}
