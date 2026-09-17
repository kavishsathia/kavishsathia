import type { Metadata } from "next";
import Link from "next/link";
import FpgaTool from "./FpgaTool";

export const metadata: Metadata = {
  title: "FPGA simulator | Kavish Sathia",
  description: "Compile and simulate Verilog/SystemVerilog with Icarus Verilog entirely in the browser, then inspect the real VCD in an interactive waveform viewer.",
};

export default function FpgaPage() {
  return <div className="flex h-dvh flex-col bg-background text-foreground">
    <header className="flex shrink-0 flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-border px-4 py-3 sm:px-6">
      <Link href="/tools" className="font-mono text-sm text-muted transition-colors hover:text-foreground">&larr; tools</Link>
      <h1 className="font-mono text-sm tracking-wider text-muted">FPGA / HDL</h1>
      <p className="hidden text-sm text-muted sm:block">Icarus Verilog in-browser · real VCD waveforms</p>
      <span className="ml-auto hidden font-mono text-[10px] text-muted md:block">RTL simulation, not physical timing</span>
    </header>
    <FpgaTool />
  </div>;
}
