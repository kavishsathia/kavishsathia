"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Image from "next/image";
import { ReactNode, useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  themeVariables: {
    primaryColor: "#e5e5e0",
    primaryTextColor: "#1a1a1a",
    primaryBorderColor: "#6b6b6b",
    lineColor: "#6b6b6b",
    secondaryColor: "#fafaf8",
    tertiaryColor: "#fafaf8",
    background: "#fafaf8",
    mainBkg: "#e5e5e0",
    nodeBorder: "#6b6b6b",
    fontFamily: "var(--font-geist-sans)",
    fontSize: "14px",
  },
});

let mermaidCounter = 0;

function Mermaid({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState("");

  useEffect(() => {
    const id = `mermaid-${mermaidCounter++}`;
    mermaid.render(id, chart).then(({ svg }) => setSvg(svg));
  }, [chart]);

  return (
    <div
      ref={containerRef}
      className="my-6 flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children: ReactNode } }).props.children);
  }
  return "";
}

export default function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      children={content}
      components={{
        h1: ({ children }) => {
          const id = slugify(extractText(children));
          return (
            <h1 id={id} className="scroll-mt-24">
              {children}
            </h1>
          );
        },
        h2: ({ children }) => {
          const id = slugify(extractText(children));
          return (
            <h2 id={id} className="scroll-mt-24">
              {children}
            </h2>
          );
        },
        img: ({ src, alt }) => {
          if (!src || typeof src !== "string") return null;
          const imgSrc = src.startsWith("/") ? src : `/blog/${src}`;
          return (
            <span className="block my-6">
              <Image
                src={imgSrc}
                alt={alt ?? ""}
                width={800}
                height={450}
                className="w-full rounded"
                unoptimized
              />
            </span>
          );
        },
        pre: ({ children }) => {
          const child = children as React.ReactElement<{ className?: string; children?: ReactNode }>;
          if (child?.props?.className === "language-mermaid") {
            return <Mermaid chart={String(child.props.children).trim()} />;
          }
          return <pre>{children}</pre>;
        },
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {children}
          </a>
        ),
      }}
    />
  );
}
