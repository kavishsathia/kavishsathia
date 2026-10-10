import type { Metadata } from "next";
import Link from "next/link";
import PlusCalTool from "./PlusCalTool";

export const metadata: Metadata = {
  title: "PlusCal & TLC | Kavish Sathia",
  description:
    "Write a PlusCal algorithm or a TLA+ spec and model-check it in the browser: the TLA+ project's own translator, SANY parser and TLC model checker, unmodified, on a JVM compiled to WebAssembly.",
};

export default function PlusCalPage() {
  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 px-6 py-4 border-b border-border flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Link href="/tools" className="font-mono text-sm text-muted hover:text-foreground transition-colors">
          &larr; tools
        </Link>
        <h1 className="font-mono text-sm tracking-wider text-muted">PLUSCAL &amp; TLC</h1>
        <p className="hidden sm:block text-sm text-muted">The TLA+ model checker, running in your browser</p>
      </header>

      <PlusCalTool />
    </div>
  );
}
