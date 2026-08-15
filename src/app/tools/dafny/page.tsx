import type { Metadata } from "next";
import Link from "next/link";
import DafnyTool from "./DafnyTool";

export const metadata: Metadata = {
  title: "Dafny | Kavish Sathia",
  description:
    "The full Dafny verifier — Dafny, Boogie, and Z3 — running entirely in the browser: the .NET toolchain on wasm, with Boogie's solver pipe rerouted to Z3 wasm. A playground with syntax highlighting and live inline diagnostics.",
};

export default function DafnyPage() {
  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 px-6 py-4 border-b border-border flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Link
          href="/tools"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; tools
        </Link>
        <h1 className="font-mono text-sm tracking-wider text-muted">DAFNY</h1>
        <p className="hidden sm:block text-sm text-muted">
          the full verifier, running in your browser
        </p>
      </header>

      <DafnyTool />
    </div>
  );
}
