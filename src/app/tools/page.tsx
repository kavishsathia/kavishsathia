import type { Metadata } from "next";
import Link from "next/link";
import { tools } from "@/lib/tools";

export const metadata: Metadata = {
  title: "Tools | Kavish Sathia",
};

export default function ToolsIndex() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="mx-auto max-w-2xl px-6 py-24 sm:py-32">
        <Link
          href="/"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; back
        </Link>

        <h1 className="font-mono text-sm tracking-wider text-muted mt-12 mb-6">
          TOOLS
        </h1>
        <p className="text-lg leading-relaxed max-w-lg">
          Small things that run in your browser. Mostly compilers and formal
          methods dragged out of the terminal and given a surface.
        </p>
      </header>

      {/* Tools */}
      <section>
        {tools.length === 0 ? (
          <div className="mx-auto max-w-2xl px-6">
            <p className="text-muted">Nothing here yet.</p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-6 flex flex-col gap-16">
            {tools.map((tool) => (
              <Link
                key={tool.id}
                href={`/tools/${tool.slug}`}
                className="group block"
              >
                <div className="flex items-baseline gap-4 mb-3">
                  <span className="font-mono text-sm text-muted">
                    {tool.id}
                  </span>
                  <h2 className="text-xl md:text-2xl font-medium group-hover:underline underline-offset-4">
                    {tool.title}
                  </h2>
                </div>
                <p className="text-sm text-muted mb-3 md:mb-4 font-mono">
                  {tool.subtitle}
                </p>
                <p className="text-sm md:text-base leading-relaxed text-accent mb-4 md:mb-6">
                  {tool.description}
                </p>
                <div className="flex flex-wrap items-center gap-2 md:gap-3">
                  {tool.tags.map((tag) => (
                    <span
                      key={tag}
                      className="font-mono text-xs text-muted border border-border px-2 py-1"
                    >
                      {tag}
                    </span>
                  ))}
                  <span className="text-border">|</span>
                  <span className="font-mono text-xs text-muted group-hover:text-foreground transition-colors">
                    open →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="mx-auto max-w-2xl px-6 py-16">
        <div className="flex justify-end">
          <span className="text-muted text-lg">∎</span>
        </div>
      </footer>
    </div>
  );
}
