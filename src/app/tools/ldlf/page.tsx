import type { Metadata } from "next";
import Link from "next/link";
import LdlfTool from "./LdlfTool";

export const metadata: Metadata = {
  title: "LDLf | Kavish Sathia",
  description:
    "Translate Linear Dynamic Logic on finite traces into a deterministic finite automaton, in the browser.",
};

export default function LdlfPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-2xl px-6 py-24 sm:py-32">
        <Link
          href="/tools"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; tools
        </Link>

        <h1 className="font-mono text-sm tracking-wider text-muted mt-12 mb-6">
          LDLf
        </h1>
        <p className="text-lg leading-relaxed mb-4">
          Linear Dynamic Logic on finite traces, translated to a deterministic
          finite automaton.
        </p>
        <p className="text-sm leading-relaxed text-accent mb-12">
          LDLf takes its syntax from propositional dynamic logic but reads it
          over finite traces, which buys you full monadic second-order
          expressiveness — strictly more than LTLf. Every formula still has an
          equivalent DFA. This runs{" "}
          <a
            href="https://github.com/whitemech/lydia"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-muted transition-colors"
          >
            Lydia
          </a>{" "}
          compiled to WebAssembly, so the translation happens on your machine.
        </p>

        <LdlfTool />

        <div className="mt-16 pt-8 border-t border-border">
          <h2 className="font-mono text-xs tracking-wider text-muted mb-4">
            SYNTAX
          </h2>
          <p className="text-sm leading-relaxed text-accent mb-4">
            Formulas are <code className="font-mono text-xs">tt</code>,{" "}
            <code className="font-mono text-xs">ff</code>,{" "}
            <code className="font-mono text-xs">end</code>,{" "}
            <code className="font-mono text-xs">last</code>, or a modality over
            a regular expression:{" "}
            <code className="font-mono text-xs">&lt;ρ&gt;φ</code> and{" "}
            <code className="font-mono text-xs">[ρ]φ</code>, combined with{" "}
            <code className="font-mono text-xs">!</code>{" "}
            <code className="font-mono text-xs">&amp;</code>{" "}
            <code className="font-mono text-xs">|</code>{" "}
            <code className="font-mono text-xs">-&gt;</code>{" "}
            <code className="font-mono text-xs">&lt;-&gt;</code>.
          </p>
          <p className="text-sm leading-relaxed text-accent">
            Regular expressions are propositional steps (
            <code className="font-mono text-xs">a</code>,{" "}
            <code className="font-mono text-xs">!a &amp; b</code>,{" "}
            <code className="font-mono text-xs">true</code>) composed with{" "}
            <code className="font-mono text-xs">;</code> (sequence),{" "}
            <code className="font-mono text-xs">+</code> (union),{" "}
            <code className="font-mono text-xs">*</code> (star), and{" "}
            <code className="font-mono text-xs">φ?</code> (test). Note that a
            bare proposition is a <em>step</em>, not a formula — &ldquo;eventually
            b&rdquo; is{" "}
            <code className="font-mono text-xs">&lt;true*;b&gt;end</code>, not{" "}
            <code className="font-mono text-xs">&lt;true*&gt;b</code>.
          </p>
        </div>

        <div className="mt-24 flex justify-end">
          <span className="text-muted text-lg">∎</span>
        </div>
      </main>
    </div>
  );
}
