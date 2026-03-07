"use client";

import { useEffect, useState } from "react";

type Heading = {
  id: string;
  text: string;
  level: number;
};

export default function TableOfContents({ content }: { content: string }) {
  const [activeId, setActiveId] = useState<string>("");

  const headings: Heading[] = content
    .split("\n")
    .filter((line) => /^#{1,2}\s/.test(line))
    .map((line) => {
      const match = line.match(/^(#{1,2})\s+(.+)$/);
      if (!match) return null;
      const text = match[2].trim();
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      return { id, text, level: match[1].length };
    })
    .filter((h): h is Heading => h !== null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // Find the first visible heading
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 }
    );

    headings.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav className="hidden xl:block fixed left-[max(2rem,calc((100vw-42rem)/2-18rem))] top-32 w-64">
      <p className="font-mono text-sm tracking-wider text-muted mb-5">
        CONTENTS
      </p>
      <ul className="space-y-3 border-l border-border">
        {headings.map(({ id, text, level }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={`block text-base leading-snug transition-all duration-200 border-l-2 -ml-px ${
                level === 2 ? "pl-6" : "pl-3"
              } ${
                activeId === id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
