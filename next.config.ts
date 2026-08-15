import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        // Z3's threaded wasm build needs SharedArrayBuffer, which browsers
        // only enable in cross-origin-isolated documents. Scoped to the one
        // tool that uses it so the rest of the site is unaffected.
        source: "/tools/ldlf-mt",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        // The Dafny tool runs the multithreaded .NET runtime + Z3 wasm, both
        // of which need SharedArrayBuffer.
        source: "/tools/dafny",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        // .NET runtime assets (dotnet.js, its worker scripts, assemblies)
        // are fetched into the cross-origin-isolated page and its workers.
        source: "/dafny/:path*",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
      {
        // The pthread workers re-fetch z3-built.js as their own script; a
        // worker script inherits the page's COEP, so its response must carry
        // these headers too or Chrome blocks it (ERR_BLOCKED_BY_RESPONSE).
        source: "/z3/:path*",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
