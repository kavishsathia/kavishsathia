# FPGA simulator: provenance and verification

## Shipped engines

### HDL simulation

- Upstream distribution: [VeriSim](https://github.com/senolgulgonul/verisim), commit `a275a9ac28c59db1130505973644c9a3754ec1d7` (2026-07-09).
- Underlying engine: Icarus Verilog 14.0 development branch, upstream commit `c7530db` (as recorded by VeriSim).
- License: GPL-2.0-or-later. The distributed license is `public/fpga/LICENSE-Icarus-GPL-2.0.txt`.
- License-file SHA-256: `8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643`.
- Unmodified upstream generated files and SHA-256: `ivlpp.js` `97d41e9cd11588b7bdbc952873cd71658165e6bd7938c5d39275cedb9ddad405`, `ivlpp.wasm` `039bfd9a34d5fb527f1309a680a8361c259bd4d6d4d1e6e91020e28da39487c0`, `ivl.js` `a2f56ba8611135d43971053605fb013550dc30d1671e9808a7f82ab02838e915`, `ivl.wasm` `8e909e2d9c7e7ee7a59c25694fa923eae3d60b78993b6e42cc2f53701dc42cea`, `vvp.js` `7bb3762198fb5297726bdd0714b4bcc2ac09d99122deefba544d45c6beaebb05`, and `vvp.wasm` `c38bf14a399b66a226fecc90285f35f465eeb759bf37aee59f6aed9cb7e948bd`.
- Local authored `fpga-worker.js` and `worker-limits.js` connect the pipeline and enforce: UTF-8 source 256 KiB before worker creation; captured preprocessor output 2 MiB; compiled MEMFS artifact 8 MiB before copying; VCD MEMFS artifact 12 MiB before UTF-8 conversion; console output 128 KiB with linear running-length accounting; replay parsing at 2,048 signals/1,000,000 transitions; and whole-worker termination after eight seconds.

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
- License-file SHA-256: `6fc9e709ccbfe0d77fbffa2427a983282be2eb88e47b1cdb49f21a83b4d1e665`.
- Unmodified generated files and SHA-256: `surfer.js` `b2b56c17bec8250932166ea7163ac94d7e4526c8b699b255452dceca7715eb28`, `surfer_bg.wasm` `7e096f8dd731f9952777ef509c997780bb3062724e3222ec96442881e3383415`, and `surfer.d.ts` `5c060714486b4cca9f33f2cc2f9014878395db83ca295c5034188333479bce23`.
- Embedding adaptations: `index.html` posts a same-origin ready event, omits PWA registration and missing manifest/favicon references, and exposes the pinned wasm exports. `integration.js` accepts commands only from the same-origin `window.parent`, supports a retry-safe readiness probe, and records accepted cursor commands for browser verification. The host loads each real simulator-produced VCD through an object URL, adds the `tb` hierarchy, and drives Surfer's real `Message::CursorSet(BigInt)` API from the single board-time scrubber.
- Adapted-file SHA-256: `index.html` `d8f4a8883806841069b160b2107372f754707a0cdbc2b1cd47ee2ec756786219`; `integration.js` `328f5f186ea51af197da3586a4429c2ea3ee21fb61dc9358b9cbe4c6a6d2f925`.

The upstream artifact was obtained using Surfer's documented integration URL:

```sh
curl -L -o surfer.zip \
  'https://gitlab.com/surfer-project/surfer/-/jobs/artifacts/main/download?job=pages_build'
unzip surfer.zip 'pages_build/index.html' 'pages_build/integration.js' \
  'pages_build/surfer.js' 'pages_build/surfer_bg.wasm' 'pages_build/surfer.d.ts'
```

The checked-in artifact was recorded as generated at 2026-09-04 11:50 UTC and associated with commit `db1ca915a989860f11c440b0a932b1f5fbce71b2`. The moving-`main` URL above is only the upstream retrieval shape, not a reproducible historical download. Reproduction requires building that exact commit (or comparing a separately retained artifact) against the hashes above; the checked-in files make deployment independent of the expiring CI artifact.

## Alternatives evaluated

- Surfer: maintained, browser/WASM build, documented iframe + `postMessage` embedding API, Wellen parser, full interactive viewer, EUPL-1.2. Selected and integrated.
- Wellen directly: maintained and BSD-3-Clause, but its public crate is a parsing/data library rather than a packaged browser UI. It is already used by Surfer, so embedding Surfer avoids recreating its rendering and interaction semantics.
- VCDrom / `vcd-stream`: browser-capable MIT viewer/parser, but the current npm viewer release (`vcdrom` 1.6.0) is from 2024 and its parser repository moved/was archived in January 2026. It also offers a less stable application-level embedding surface than Surfer.
- WaveDrom: maintained and MIT, but accepts WaveJSON timing-diagram descriptions rather than VCD as its native inspection model; translating simulation output would discard event/hierarchy fidelity and produce a documentation diagram rather than a simulator viewer.
- Vaporview: active and Wellen-backed, but delivered as an AGPL VS Code extension rather than an embeddable web component.

`src/lib/fpga/replay.ts` is not the waveform viewer/parser. It is a deliberately bounded adapter that extracts values for the small board-replay panel and screen-reader test status. Surfer/Wellen is authoritative for waveform parsing and display.

## Verification record

Run from repository root on 2026-09-17:

- `npm test`: 11 tests passed. Covers hierarchy/timestamps, scalar and bus X/Z preservation, exact step values, transition limits, user stop, timeout termination, UTF-8 source sizing, stale-run invalidation/supersession, bounded linear console capture, and rejecting an oversized artifact before `readFile` conversion.
- `npm ci`: passed, including the existing `postinstall` asset step (708 packages audited).
- `npx eslint src/app/tools/fpga src/lib/fpga src/types tests/e2e playwright.config.ts vitest.config.ts public/fpga/fpga-worker.js --max-warnings 0`: passed with no warnings.
- `npm run typecheck`: passed.
- `npm run build`: passed; `/tools/fpga` statically generated.
- `npm run lint -- --quiet`: the new FPGA source is clean; repository-wide lint still fails on the pre-existing authored `react/no-children-prop` error at `src/components/Markdown.tsx:67`. Generated CEL, Dafny, Icarus, and Surfer files are explicitly ignored; authored `fpga-worker.js` is not ignored.
- `npm run test:e2e`: 8 passed, 8 intentionally project-skipped. Tests run against the fresh production build via `next start`. They verify named LED counter transitions at 65,000 ps and 125,000 ps in the downloaded real Icarus VCD; Surfer load; a host scrub driving the accepted Surfer primary cursor command and board time; rejection of wrong-origin and foreign-source commands; edit-during-run and supersession; causal syntax failure; X/Z; a real infinite Icarus simulation terminated after eight seconds with the causal diagnostic; and the mobile journey. Tests capture desktop/mobile screenshots and fail on browser console errors.
- Desktop and Pixel 7 screenshots were inspected. Desktop shows Surfer populated with the deterministic counter hierarchy and transitions; the narrow layout keeps both editors, run/board controls, scrubber, and viewer reachable by scrolling.

## Known limitations

- This is bounded batch RTL simulation, not a live FPGA, physical timing, synthesis, placement, routing, or metastability model.
- The compact board is a replay of selected signals from the completed VCD; changing inputs requires editing stimulus and rerunning. Pinned Surfer exposes cursor-setting but no host cursor-change event, so the host scrubber is the single synchronized board/viewer time control; direct pointer interaction inside Surfer is not reflected back to the board.
- The eight-second deadline terminates the whole Web Worker. Emscripten does not provide a safe in-process interrupt for a running `vvp` call.
- These exact generated Icarus modules define and export their own growable WebAssembly memories rather than importing `WebAssembly.Memory`; they therefore reject an externally configured memory and retain Emscripten's compiled 2 GiB heap ceiling. Without rebuilding upstream, browser/WASM allocation growth below that ceiling and transient MEMFS allocations while an engine is writing cannot be capped from JavaScript. Pre-copy artifact checks, capture bounds, the browser's own allocation failure, and hard worker termination are the enforceable boundaries; no tighter total-memory claim is made.
- The full Surfer application adds about 15 MiB of WASM. Keeping it local is intentional: it preserves privacy/offline behavior, pins provenance, and avoids depending on expiring CI artifacts or a third-party origin.
