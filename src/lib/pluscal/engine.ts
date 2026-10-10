/**
 * PlusCal and TLC in the browser.
 *
 * The real thing: the TLA+ project's own tla2tools.jar (nightly, rev
 * 94d0c50) — the PlusCal translator, the SANY parser, and the TLC model
 * checker — plus the TLA+ Community Modules its manifest expects beside it,
 * unmodified, on CheerpJ (a JVM in WebAssembly/JavaScript). A small facade
 * (wasm-src/pluscal) runs each request the way `java pcal.trans` and
 * `java tlc2.TLC` would, in a fresh classloader so no state survives from
 * one run to the next.
 *
 * CheerpJ runs one call from JavaScript at a time, so a running check can't
 * be interrupted by calling into Java; instead Java polls `stopRequested`.
 * Output streams back line by line through the `emit` native.
 */

export class EngineUnavailableError extends Error {
  constructor(cause?: string) {
    super(cause ?? "The model checker could not be loaded.");
    this.name = "EngineUnavailableError";
  }
}

/**
 * CheerpJ can be initialised once per page, with one set of natives. The CEL
 * tool initialises it with its Z3 bridge; arriving here from there by
 * client-side navigation needs a fresh page.
 */
export class RuntimeTakenError extends EngineUnavailableError {
  constructor() {
    super("Another tool started the JVM on this page.");
    this.name = "RuntimeTakenError";
  }
}

export type LoadPhase = "cheerpj" | "jar";

export type TranslateResult = {
  /** pcal.trans's status: 0 on success. */
  status: number;
  /** The module with the translation inserted (null if it failed). */
  tla: string | null;
  /** The .cfg the translator generates (null if it failed). */
  cfg: string | null;
  messages: string[];
};

export type CheckResult = {
  /** TLC's exit status (tlc2.output.EC.ExitStatus); -1 if it rejected the arguments. */
  status: number;
  /** True if the run ended because the page asked it to stop. */
  stopped: boolean;
};

export type EngineFailure = { error: string; stack: string };

export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: EngineFailure };

type JavaFacade = {
  ping(): Promise<string>;
  translate(name: string, tla: string, options: string): Promise<string>;
  check(name: string, tla: string, cfg: string, args: string): Promise<string>;
};

declare global {
  interface Window {
    cheerpjInit?: (opts: Record<string, unknown>) => Promise<void>;
    cheerpjRunLibrary?: (classPath: string) => Promise<unknown>;
    /** Which tool initialised CheerpJ on this page. */
    __cheerpjOwner?: string;
  }
}

export const CHEERPJ_VERSION = "4.3";
const CHEERPJ_LOADER_URL = `https://cjrtnc.leaningtech.com/${CHEERPJ_VERSION}/loader.js`;
/** CheerpJ mounts the page origin at /app. */
const FACADE_CLASSPATH = "/app/pluscal/pluscal-web.jar";
const OWNER = "pluscal";

/** Where the running check's output goes, and whether it should stop. */
let lineSink: ((line: string) => void) | null = null;
let stopFlag = false;

const natives = {
  async Java_site_pluscal_PlusCalWeb_emit(_lib: unknown, line: string) {
    lineSink?.(line);
  },
  async Java_site_pluscal_PlusCalWeb_stopRequested() {
    return stopFlag ? 1 : 0;
  },
  // CheerpJ 4.3's JVM lacks these Unsafe intrinsics; TLC reaches them via
  // VarHandle fences (e.g. in the Community Modules' FoldSet). Java threads
  // here are green threads on one JS thread, so a fence has nothing to order.
  Java_jdk_internal_misc_Unsafe_fullFence() {},
  Java_jdk_internal_misc_Unsafe_loadFence() {},
  Java_jdk_internal_misc_Unsafe_storeFence() {},
};

function loadScript(src: string, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => (ready() ? resolve() : reject(new EngineUnavailableError(`${src} loaded but did not initialise.`)));
    script.onerror = () => reject(new EngineUnavailableError(`Failed to fetch ${src}.`));
    document.head.appendChild(script);
  });
}

let enginePromise: Promise<JavaFacade> | null = null;

/** Boots the JVM, then the facade. Idempotent. */
export function loadEngine(onPhase?: (phase: LoadPhase) => void): Promise<JavaFacade> {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    try {
      if (window.__cheerpjOwner && window.__cheerpjOwner !== OWNER) throw new RuntimeTakenError();
      onPhase?.("cheerpj");
      await loadScript(CHEERPJ_LOADER_URL, () => typeof window.cheerpjInit === "function");
      window.__cheerpjOwner = OWNER;
      await window.cheerpjInit!({
        version: 11,
        status: "none",
        natives,
        javaProperties: [
          "user.timezone=UTC",
          // Progress lines every second instead of every minute.
          "tlc2.TLC.progressInterval=1",
        ],
      });

      onPhase?.("jar");
      const lib = (await window.cheerpjRunLibrary!(FACADE_CLASSPATH)) as {
        site: { pluscal: { PlusCalWeb: Promise<JavaFacade> } };
      };
      const facade = await lib.site.pluscal.PlusCalWeb;
      await facade.ping();
      return facade;
    } catch (e) {
      enginePromise = null;
      if (e instanceof EngineUnavailableError) throw e;
      throw new EngineUnavailableError(e instanceof Error ? e.message : String(e));
    }
  })();

  return enginePromise;
}

/** The JVM runs one call at a time; requests queue. */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function parse<T>(json: string): Outcome<T> {
  const raw = JSON.parse(json) as { ok: boolean } & Record<string, unknown>;
  if (raw.ok) {
    const value: Record<string, unknown> = { ...raw };
    delete value.ok;
    return { ok: true, value: value as T };
  }
  return { ok: false, failure: { error: String(raw.error ?? ""), stack: String(raw.stack ?? "") } };
}

/** `java pcal.trans [options] <name>.tla`, on `tla` as the file's contents. */
export function translate(name: string, tla: string, options: string[] = []): Promise<Outcome<TranslateResult>> {
  return enqueue(async () => {
    const f = await loadEngine();
    return parse<TranslateResult>(await f.translate(name, tla, options.join("\n")));
  });
}

/**
 * `java tlc2.TLC [args] -config <name>.cfg <name>.tla`. Lines of output
 * (in -tool framing if `args` asks for it) go to `onLine` as TLC prints them.
 */
export function check(
  name: string,
  tla: string,
  cfg: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<Outcome<CheckResult>> {
  return enqueue(async () => {
    const f = await loadEngine();
    stopFlag = false;
    lineSink = onLine;
    try {
      const out = parse<{ status: number }>(await f.check(name, tla, cfg, args.join("\n")));
      return out.ok ? { ok: true, value: { status: out.value.status, stopped: stopFlag } } : out;
    } finally {
      lineSink = null;
      stopFlag = false;
    }
  });
}

/** Asks the running check to stop; TLC finishes its current step and reports. */
export function requestStop() {
  if (lineSink) stopFlag = true;
}

/** `---- MODULE Name ----`: TLC needs the file to be called Name.tla. */
export function moduleName(tla: string): string | null {
  const m = /^\s*-{4,}\s*MODULE\s+(\w+)\s*-{4,}/m.exec(tla);
  return m ? m[1] : null;
}

/** Does the module contain a PlusCal algorithm that needs translating? */
export function hasAlgorithm(tla: string): boolean {
  return /--(?:fair\s+)?algorithm\b/.test(tla);
}
