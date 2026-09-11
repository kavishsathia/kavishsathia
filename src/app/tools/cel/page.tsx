import type { Metadata } from "next";
import Link from "next/link";
import CelTool from "./CelTool";

export const metadata: Metadata = {
  title: "CEL verifier | Kavish Sathia",
  description:
    "Google's Z3-backed formal verifier for the Common Expression Language, running entirely in the browser: the unmodified cel-java verifier on a JVM compiled to WebAssembly, with its JNI binding to Z3 rerouted into Z3 wasm.",
};

export default function CelPage() {
  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 px-6 py-4 border-b border-border flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Link
          href="/tools"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; tools
        </Link>
        <h1 className="font-mono text-sm tracking-wider text-muted">CEL VERIFIER</h1>
        <p className="hidden sm:block text-sm text-muted">
          Google&apos;s Z3 verifier for CEL, running in your browser
        </p>
      </header>

      <CelTool />
    </div>
  );
}
