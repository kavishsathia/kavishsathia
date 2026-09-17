# Browser FPGA simulator — implementation contract

## Product

Add a sixth tool at `/tools/fpga`: a polished, full-screen browser FPGA/HDL simulator. It should feel native to this site and specifically follow the full-width Dafny tool rather than a centered marketing-card layout.

The tool is a hybrid:

1. Users write a Verilog/SystemVerilog design and testbench.
2. A real, established HDL simulation engine runs the code client-side.
3. Real simulation output feeds a rich waveform viewer, which is the visual and interaction centerpiece.
4. A smaller virtual FPGA-board panel maps selected top-level/testbench signals to switches, buttons, clocks, LEDs, and optionally seven-segment output.

This is an RTL simulation and signal-exploration tool, not a claim to model physical timing, placement, routing, metastability, or a particular FPGA chip unless those capabilities are genuinely implemented.

## Non-negotiable technical rule

Do **not** implement a toy Verilog parser, evaluator, simulator, or waveform renderer when a proven implementation can be compiled or integrated.

First research and inspect viable existing projects/packages. Prefer a real browser-compatible build of Icarus Verilog, Verilator, or another established simulator. Prefer an established VCD/FST parser and waveform visualization component/engine. Compile or adapt a proven upstream project when needed rather than recreating its semantics.

Before selecting dependencies, verify:

- the package/project actually exists and can execute in this repository;
- browser compatibility and current maintenance state;
- license compatibility and attribution requirements;
- that the HDL engine really compiles/runs input and produces real waveform data;
- that the waveform viewer consumes the simulator output, rather than displaying a canned fixture.

If no viable browser engine can be made to work within the environment, stop with concrete evidence and a precise blocker. Do not substitute a fake simulator or hard-coded waveform.

## User journey

A first-time visitor opens `/tools/fpga` and immediately sees a full-screen engineering workspace:

- compact site/tool header;
- design and testbench editors;
- run/stop controls and simulation status;
- waveform viewer occupying the largest region;
- compact board/I/O panel;
- compiler/runtime diagnostics.

The default example must run with one action and produce a nontrivial waveform. Use an understandable FPGA-style example such as a clock divider/counter with reset and output LEDs. Include at least two additional examples that prove different behavior (for example PWM and edge-triggered state/traffic light logic).

On Run:

1. compile the actual design and testbench;
2. execute simulation with bounded time/resource limits;
3. obtain genuine waveform output;
4. populate the waveform viewer from that output;
5. show compile/runtime diagnostics causally and inline;
6. update mapped board outputs from selected simulation time or interactive simulation state where technically sound.

## Waveform viewer — the star

Use an established viewer/component where feasible. It must be a serious inspection surface, not a decorative timing diagram.

Required behavior:

- hierarchical signal list when present;
- digital scalar and bus rendering;
- time axis with units;
- horizontal zoom and pan;
- cursor/scrubber with exact time readout;
- values at the cursor;
- fit-to-trace;
- signal visibility controls;
- sensible handling of X/Z values;
- useful empty, compiling, simulation-failed, and no-dump states;
- keyboard/mouse behavior that remains usable on a laptop;
- no misleading interpolation between digital transitions.

Nice if supported by the proven viewer without destabilizing scope:

- two cursors and delta measurement;
- radix selection for buses;
- grouping/collapse;
- signal search;
- export/download of VCD.

## Board panel

The board is subordinate to the waveform viewer. It should provide a compact, tasteful visual affordance—not a cartoon motherboard.

Include:

- clock and reset controls;
- switches/buttons or equivalent mapped inputs;
- LED-style mapped outputs;
- explicit signal mappings;
- clear distinction between interactive input state and replaying a completed testbench waveform.

Do not claim live interaction if the selected simulator can only run bounded batch simulations. In that case, controls may set parameters/input stimulus and re-run simulation, with that behavior clearly communicated.

## Existing-site fit

Inspect and reuse the Dafny tool’s structural language:

- full viewport workspace rather than centered content;
- CodeMirror treatment, typography, neutral palette, borders, spacing, diagnostics, and status language;
- responsive behavior;
- shareable URL state if reasonably consistent with Dafny/CSP#;
- tool registry entry in `src/lib/tools.ts`;
- dedicated page metadata and explanatory copy;
- no unrelated redesign of existing pages.

Avoid generic gradient SaaS styling, oversized hero text, glowing cards, or visual language that does not belong to this site.

## Architecture and safety

- Client-side simulation only; no new backend or uploaded source code.
- Run heavy simulation/parsing work away from the React render path, preferably in a Web Worker.
- Bound simulation time, output size, memory exposure, and infinite-testbench behavior.
- Avoid checking in unnecessary generated binaries when a reproducible build/download path is appropriate, but deployment must remain reliable on Vercel/static assets.
- Record upstream source, exact version/commit, license, build procedure, and modifications.
- Keep generated artifacts distinguishable from authored source.

## Verification requirements

Implement focused RED→GREEN tests for deterministic integration behavior, including:

1. a real known Verilog design/testbench compiles and emits expected transitions;
2. a syntax error produces a useful diagnostic and no stale waveform;
3. X/Z and bus values survive the simulation-output-to-viewer path;
4. the waveform timeline corresponds to simulator timestamps;
5. selecting/scrubbing time updates displayed values correctly;
6. runaway or excessive simulations are bounded;
7. changing source invalidates stale results;
8. the default example works through the actual UI journey.

Run and report:

- dependency installation from a clean checkout;
- lint;
- TypeScript check if separate;
- unit/integration tests;
- production build;
- browser E2E of the core journey against fresh build output;
- desktop visual inspection;
- narrow/mobile inspection for usable fallback layout;
- console/runtime error inspection.

Do not weaken existing checks, hide errors, use `any` to suppress integration problems, or declare success from a canned waveform.

## Repository rules

- Work only on `feat/fpga-simulator` in this repository.
- Do not push, deploy, alter GitHub/Vercel settings, or touch external infrastructure.
- Keep existing tools working.
- Commit the implementation when complete with a factual summary.
- Leave a concise evidence report describing selected upstream engines, licenses, commands run, actual results, and known limitations.
