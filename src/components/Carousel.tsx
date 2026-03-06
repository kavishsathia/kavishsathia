"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export default function Carousel({
  slug,
  imageCount,
}: {
  slug: string;
  imageCount: number;
}) {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (imageCount <= 1) return;
    const interval = setInterval(() => {
      setCurrent((prev) => (prev + 1) % imageCount);
    }, 3000);
    return () => clearInterval(interval);
  }, [imageCount]);

  return (
    <div className="relative w-full h-full">
      {Array.from({ length: imageCount }).map((_, i) => (
        <Image
          key={i}
          src={`/projects/${slug}/${i}.png`}
          alt={`${slug} screenshot ${i}`}
          fill
          className={`object-cover transition-opacity duration-700 ${
            i === current ? "opacity-100" : "opacity-0"
          }`}
        />
      ))}
      {imageCount > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 z-10">
          {Array.from({ length: imageCount }).map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrent(i)}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === current ? "bg-white" : "bg-white/40"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
