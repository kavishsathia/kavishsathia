# FPGA simulator: provenance and verification

## Shipped engines

### HDL simulation

- Upstream distribution: [VeriSim](https://github.com/senolgulgonul/verisim), commit `a275a9ac28c59db1130505973644c9a3754ec1d7` (2026-07-09).
- Underlying engine: Icarus Verilog 14.0 development branch, upstream commit `c7530db` (as recorded by VeriSim).
- License: GPL-2.0-or-later. The distributed license is `public/fpga/LICENSE-Icarus-GPL-2.0.txt`.
- Unmodified upstream generated files: `ivlpp.js/.wasm`, `ivl.js/.wasm`, and `vvp.js/.wasm`. Their SHA-256 hashes match the six files at the VeriSim commit above.
- Local authored modification: `fpga-worker.js` supplies bounded browser orchestration around the upstream `ivlpp -> ivl -> vvp` pipeline. It normalizes pasted Unicode, uses MEMFS, captures diagnostics/output, caps source at 256 KiB and VCD at 12 MiB, and is terminated by the caller after eight seconds.

The upstream binaries can be reproduced/copied with:

```sh
git clone https://github.com/senolgulgonul/verisim.git
git -C verisim checkout a275a9ac28c59db1130505973644c9a3754ec1d7
cp verisim/{ivlpp,ivl,vvp}.{js,wasm} public/fpga/
sha256sum public/fpga/{ivlpp,ivl,vvp}.{js,wasm}
```

### Waveform inspection

- Selected upstream: [Surfer](https://gitlab.com/surfer-project/surfer), commit `db1ca915a989860f11c440b0a932b1f5fbce71b2` (2026-09-04), browser artifact from its `pages_build` CI job.
- Parser backend bundled by that commit: Wellen `0.25.6`, a maintained Rust VCD/FST/GHW parser.
- License: EUPL-1.2. The distributed license is `public/fpga/surfer/LICENSE-EUPL-1.2.txt`.
- Unmodified generated files: `surfer.js`, `surfer_bg.wasm`, and `surfer.d.ts`.
- Small embedding adaptations: `index.html` posts a same-origin ready event and omits Surfer's PWA service-worker registration; `integration.js` explicitly calls the wasm exports through `window` so module/classic-script scoping is deterministic. The React host loads each real simulator-produced VCD through an object URL and asks Surfer to add the `tb` hierarchy recursively.

The upstream artifact was obtained using Surfer's documented integration URL:

```sh
curl -L -o surfer.zip \
  'https://gitlab.com/surfer-project/surfer/-/jobs/artifacts/main/download?job=pages_build'
unzip surfer.zip 'pages_build/index.html' 'pages_build/integration.js' \
  'pages_build/surfer.js' 'pages_build/surfer_bg.wasm' 'pages_build/surfer.d.ts'
```

The artifact used here was generated at 2026-09-04 11:50 UTC, immediately after commit `db1ca915a989860f11c440b0a932b1f5fbce71b2`. Pinning the commit and retaining the generated assets makes deployment independent of the one-hour CI artifact expiry.

## Alternatives evaluated

- Surfer: maintained, browser/WASM build, documented iframe + `postMessage` embedding API, Wellen parser, full interactive viewer, EUPL-1.2. Selected and integrated.
- Wellen directly: maintained and BSD-3-Clause, but its public crate is a parsing/data library rather than a packaged browser UI. It is already used by Surfer, so embedding Surfer avoids recreating its rendering and interaction semantics.
- VCDrom / `vcd-stream`: browser-capable MIT viewer/parser, but the current npm viewer release (`vcdrom` 1.6.0) is from 2024 and its parser repository moved/was archived in January 2026. It also offers a less stable application-level embedding surface than Surfer.
- WaveDrom: maintained and MIT, but accepts WaveJSON timing-diagram descriptions rather than VCD as its native inspection model; translating simulation output would discard event/hierarchy fidelity and produce a documentation diagram rather than a simulator viewer.
- Vaporview: active and Wellen-backed, but delivered as an AGPL VS Code extension rather than an embeddable web component.

`src/lib/fpga/replay.ts` is not the waveform viewer/parser. It is a deliberately bounded adapter that extracts values for the small board-replay panel and screen-reader test status. Surfer/Wellen is authoritative for waveform parsing and display.

## Verification record

Run from repository root on 2026-09-17:

- `npm test`: 5 tests passed. Covers hierarchy/timestamps, scalar and bus X/Z preservation, exact step values, transition limits, user stop, and real worker termination at the timeout.
- `npm ci`: passed, including the existing `postinstall` asset step (708 packages audited).
- `npx eslint src/app/tools/fpga src/lib/fpga src/types tests/e2e playwright.config.ts vitest.config.ts public/fpga/fpga-worker.js --max-warnings 0`: passed with no warnings.
- `npm run typecheck`: passed.
- `npm run build`: passed; `/tools/fpga` statically generated.
- `npm run lint -- --quiet`: the new FPGA source is clean; repository-wide lint still fails on the pre-existing authored `react/no-children-prop` error at `src/components/Markdown.tsx:67`. Generated CEL, Dafny, Icarus, and Surfer files are explicitly ignored; authored `fpga-worker.js` is not ignored.
- `npm run test:e2e`: 5 passed, 5 intentionally project-skipped. Tests run against a fresh `next build` via `next start`, assert the actual Icarus-produced result and Surfer/Wellen's waveform-loaded handshake, verify actual downloaded VCD bus X/Z values, source invalidation, and causal syntax failure, exercise the mobile journey, capture desktop/mobile screenshots, and fail on browser console errors.
- Desktop and Pixel 7 screenshots were inspected. Desktop shows Surfer populated with the real counter hierarchy, scalar and bus traces, X regions, values, and time grid; the narrow layout keeps both editors, run/board controls, and the loaded viewer reachable by scrolling.

## Known limitations

- This is bounded batch RTL simulation, not a live FPGA, physical timing, synthesis, placement, routing, or metastability model.
- The compact board is a replay of selected signals from the completed VCD; changing inputs requires editing stimulus and rerunning.
- The eight-second deadline terminates the whole Web Worker. Emscripten does not provide a safe in-process interrupt for a running `vvp` call.
- The full Surfer application adds about 15 MiB of WASM. Keeping it local is intentional: it preserves privacy/offline behavior, pins provenance, and avoids depending on expiring CI artifacts or a third-party origin.
