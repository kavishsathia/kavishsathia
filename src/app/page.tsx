import Carousel from "@/components/Carousel";
import { ReactNode } from "react";

const L = ({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="underline underline-offset-2 hover:text-foreground transition-colors"
  >
    {children}
  </a>
);

const projects: {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  description: ReactNode;
  tags: string[];
  link?: string;
  linkLabel?: string;
  imageCount: number;
}[] = [
  {
    id: "01",
    slug: "star",
    title: "Star",
    subtitle: "A programming language that compiles to WebAssembly",
    description: (
      <>
        A statically-typed programming language that compiles to{" "}
        <L href="https://webassembly.org">WebAssembly</L>, facilitating
        seamless cross-language library development. Write once, generate
        idiomatic APIs for Python, JavaScript, Rust, and Go. No more parallel
        SDK maintenance.
      </>
    ),
    tags: ["Compiler", "WebAssembly", "Type System"],
    link: "https://starlang.dev",
    linkLabel: "starlang.dev",
    imageCount: 3,
  },
  {
    id: "02",
    slug: "sworn",
    title: "Sworn",
    subtitle: "The AI accountability framework",
    description: (
      <>
        A framework for observing silent errors in AI agent executions at scale.
        Developers define behavioural contracts and a separate verifier evaluates
        deliverables against them. Features semantic, deterministic and{" "}
        <L href="https://en.wikipedia.org/wiki/Natural_language_inference">
          NLI
        </L>{" "}
        verifiers, plus a contract coverage metric to surface unmonitored
        behaviours.
      </>
    ),
    tags: ["AI Agents", "Verification", "pip library"],
    link: "https://github.com/kavishsathia/sworn",
    linkLabel: "github",
    imageCount: 3,
  },
  {
    id: "03",
    slug: "gauntlet",
    title: "Gauntlet",
    subtitle: "Adversarial fuzz-testing for AI agents",
    description: (
      <>
        An autonomous adversarial agent that intercepts your AI agent&apos;s
        tool calls in real time, creatively manipulating results to discover
        security flaws like{" "}
        <L href="https://en.wikipedia.org/wiki/Prompt_injection">
          prompt injection
        </L>
        , data exfiltration, and content poisoning. Uses a closed
        hypothesize-prove-store cycle with short-term and long-term memory
        circuits built entirely within{" "}
        <L href="https://www.elastic.co/elasticsearch/agent-builder">
          Elasticsearch Agent Builder
        </L>
        .
      </>
    ),
    tags: ["Elasticsearch", "ES|QL", "Python", "OpenAI Agents SDK"],
    link: "https://github.com/kavishsathia/gauntlet",
    linkLabel: "github",
    imageCount: 3,
  },
  {
    id: "04",
    slug: "vault",
    title: "Vault",
    subtitle: "Privacy-first universal preference management",
    description: (
      <>
        A system that eliminates the{" "}
        <L href="https://en.wikipedia.org/wiki/Cold_start_(recommender_systems)">
          cold start problem
        </L>{" "}
        by letting preferences follow users across apps. Raw text never leaves
        the device: client-side{" "}
        <L href="https://webllm.mlc.ai">WebLLM</L> generates semantic
        embeddings stored via{" "}
        <L href="https://github.com/pgvector/pgvector">pgvector</L>, with
        game-theoretic anti-gaming and temporal decay.
      </>
    ),
    tags: ["FastAPI", "pgvector", "WebLLM", "OAuth 2.0"],
    link: "https://github.com/kavishsathia/vault",
    linkLabel: "github",
    imageCount: 3,
  },
  {
    id: "05",
    slug: "oz",
    title: "Oz",
    subtitle: "An AI operating system built under 24 hours",
    description: (
      <>
        An OS where software is an extendable primitive. Users generate, modify
        and publish applications via natural language, with{" "}
        <L href="https://developers.google.com/drive">Google Drive</L> as the
        backing filesystem. Features an OzSDK mimicking Linux syscalls. Top 9 at{" "}
        <L href="https://hacknroll.nushackers.org">Hack&amp;Roll 2026</L>.
      </>
    ),
    tags: ["Next.js", "PostgreSQL", "OpenAI"],
    link: "https://github.com/kavishsathia/oz",
    linkLabel: "github",
    imageCount: 3,
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="mx-auto max-w-2xl px-6 py-24 sm:py-32">
        <h1 className="font-mono text-sm tracking-wider text-muted mb-6">
          KAVISH SATHIA
        </h1>
        <p className="text-lg leading-relaxed max-w-lg">
          Computer Science at{" "}
          <a
            href="https://nus.edu.sg"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-muted transition-colors"
          >
            NUS
          </a>
          . I&apos;m working toward the{" "}
          <a
            href="https://en.wikipedia.org/wiki/DWIM"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-muted transition-colors"
          >
            DWIM
          </a>{" "}
          (Do What I Mean) compiler: building the tools that close the gap
          between what a human means and what a machine does.
        </p>
        <div className="mt-6 flex gap-6 font-mono text-sm text-muted">
          <a
            href="mailto:kavishwer@u.nus.edu"
            className="hover:text-foreground transition-colors"
          >
            email
          </a>
          <a
            href="https://linkedin.com/in/kavish-sathia/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            linkedin
          </a>
          <a
            href="https://github.com/kavishsathia"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            github
          </a>
          <a
            href="/writing"
            className="hover:text-foreground transition-colors"
          >
            writing
          </a>
        </div>
      </header>

      {/* Projects */}
      <section>
        <div className="mx-auto max-w-2xl px-6 mb-12">
          <h2 className="font-mono text-sm tracking-wider text-muted">
            SELECTED WORK
          </h2>
        </div>

        <div className="flex flex-col">
          {projects.map((project, index) => {
            const isEven = index % 2 === 0;

            return (
              <div
                key={project.id}
                className={`flex flex-col md:min-h-[500px] ${
                  isEven ? "md:flex-row" : "md:flex-row-reverse"
                }`}
              >
                {/* Text */}
                <div className="flex-1 flex items-center px-6 py-8 md:py-12 md:px-16 lg:px-24">
                  <div className={`max-w-md ${isEven ? "md:ml-auto" : ""}`}>
                    <div className="flex items-baseline gap-4 mb-3">
                      <span className="font-mono text-sm text-muted">
                        {project.id}
                      </span>
                      <h3 className="text-xl md:text-2xl font-medium">
                        {project.title}
                      </h3>
                    </div>
                    <p className="text-sm text-muted mb-3 md:mb-4 font-mono">
                      {project.subtitle}
                    </p>
                    <p className="text-sm md:text-base leading-relaxed text-accent mb-4 md:mb-6">
                      {project.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 md:gap-3">
                      {project.tags.map((tag) => (
                        <span
                          key={tag}
                          className="font-mono text-xs text-muted border border-border px-2 py-1"
                        >
                          {tag}
                        </span>
                      ))}
                      {project.link && (
                        <>
                          <span className="text-border">|</span>
                          <a
                            href={project.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-xs text-muted hover:text-foreground transition-colors"
                          >
                            {project.linkLabel} →
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Carousel — diagonal clip only on md+ */}
                <div
                  className={`relative overflow-hidden bg-neutral-900 h-64 md:h-auto md:flex-1 md:min-h-[400px] ${
                    isEven ? "clip-left" : "clip-right"
                  }`}
                >
                  <Carousel
                    slug={project.slug}
                    imageCount={project.imageCount}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer */}
      <footer className="mx-auto max-w-2xl px-6 py-16">
        <div className="pt-8 border-t border-border flex items-center justify-between">
          <p className="font-mono text-xs text-muted">
            4.96/5.0 GPA · 3x Dean&apos;s List · 4x Hackathon Wins
          </p>
          <span className="text-muted text-lg">∎</span>
        </div>
      </footer>
    </div>
  );
}
