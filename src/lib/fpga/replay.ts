import type { LogicValue, WaveData, WaveSignal } from "./types";

const TIME_UNITS = new Set(["s", "ms", "us", "ns", "ps", "fs"]);

function normalizeValue(value: string, width: number): LogicValue {
  const lower = value.toLowerCase();
  if (width <= 1) return lower[0] ?? "x";
  if (/^[xz]$/.test(lower)) return lower.repeat(width);
  return lower.padStart(width, lower.includes("z") ? "z" : lower.includes("x") ? "x" : "0");
}

/**
 * Extract the bounded subset used by the board replay and accessible status.
 * The authoritative parser and renderer are Surfer's Wellen backend; this
 * adapter deliberately does not power the waveform inspection surface.
 */
export function parseVcdReplay(text: string, limits = { maxSignals: 2048, maxTransitions: 1_000_000 }): WaveData {
  const signalsById = new Map<string, WaveSignal>();
  const signals: WaveSignal[] = [];
  const scopes: string[] = [];
  let currentTime = 0;
  let endTime = 0;
  let transitionCount = 0;
  let timescale: WaveData["timescale"] = null;
  let inDefinitions = true;

  const tokens = text.replace(/\r/g, "").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (inDefinitions) {
      if (token === "$scope") {
        i += 1; // kind
        const name = tokens[++i];
        if (name) scopes.push(name);
        while (tokens[i] !== "$end" && i < tokens.length) i += 1;
      } else if (token === "$upscope") {
        scopes.pop();
        while (tokens[i] !== "$end" && i < tokens.length) i += 1;
      } else if (token === "$timescale") {
        const raw = tokens[++i] ?? "";
        const joined = /^\d+$/.test(raw) ? `${raw}${tokens[++i] ?? ""}` : raw;
        const match = joined.match(/^(\d+)(s|ms|us|ns|ps|fs)$/);
        if (match && TIME_UNITS.has(match[2])) {
          timescale = { multiplier: Number(match[1]), unit: match[2] as NonNullable<WaveData["timescale"]>["unit"] };
        }
        while (tokens[i] !== "$end" && i < tokens.length) i += 1;
      } else if (token === "$var") {
        const kind = tokens[++i] ?? "wire";
        const width = Math.max(1, Number(tokens[++i]) || 1);
        const id = tokens[++i];
        const referenceParts: string[] = [];
        while (tokens[i + 1] !== "$end" && i + 1 < tokens.length) referenceParts.push(tokens[++i]);
        i += 1;
        if (id && !signalsById.has(id) && signals.length < limits.maxSignals) {
          const name = referenceParts.join(" ") || id;
          const signal: WaveSignal = { id, name, path: [...scopes], width, kind, transitions: [] };
          signalsById.set(id, signal);
          signals.push(signal);
        }
      } else if (token === "$enddefinitions") {
        inDefinitions = false;
      } else if (token.startsWith("$")) {
        while (tokens[i] !== "$end" && i < tokens.length) i += 1;
      }
      continue;
    }

    if (token[0] === "#") {
      currentTime = Number(token.slice(1)) || 0;
      endTime = Math.max(endTime, currentTime);
      continue;
    }
    if (token[0] === "$" || token === "$end") continue;

    let id: string;
    let value: string;
    if (/^[bBrR]/.test(token)) {
      value = token.slice(1);
      id = tokens[++i] ?? "";
    } else {
      value = token[0];
      id = token.slice(1);
    }
    const signal = signalsById.get(id);
    if (!signal) continue;
    if (++transitionCount > limits.maxTransitions) throw new Error("Waveform exceeds the 1,000,000-transition safety limit.");
    const normalized = normalizeValue(value, signal.width);
    const previous = signal.transitions.at(-1);
    if (!previous || previous[1] !== normalized) signal.transitions.push([currentTime, normalized]);
  }

  return { timescale, endTime: Math.max(1, endTime), signals };
}

export function valueAt(signal: WaveSignal, time: number): LogicValue {
  let low = 0;
  let high = signal.transitions.length - 1;
  let found = "x".repeat(signal.width);
  while (low <= high) {
    const mid = (low + high) >> 1;
    const transition = signal.transitions[mid];
    if (transition[0] <= time) {
      found = transition[1];
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

export function formatLogic(value: string, radix: "hex" | "bin" = "hex"): string {
  if (value.length === 1 || radix === "bin") return value;
  if (/[xz]/i.test(value)) return value;
  return `0x${BigInt(`0b${value}`).toString(16)}`;
}

export function formatTime(raw: number, timescale: WaveData["timescale"]): string {
  if (!timescale) return String(Math.round(raw));
  const exponents = { s: 0, ms: -3, us: -6, ns: -9, ps: -12, fs: -15 } as const;
  const seconds = raw * timescale.multiplier * 10 ** exponents[timescale.unit];
  const units = [["s", 1], ["ms", 1e-3], ["us", 1e-6], ["ns", 1e-9], ["ps", 1e-12], ["fs", 1e-15]] as const;
  for (const [unit, size] of units) {
    const value = seconds / size;
    const rounded = Math.round(value);
    if (rounded !== 0 && Math.abs(value - rounded) < Math.max(1e-9, Math.abs(value) * 1e-9)) return `${rounded} ${unit}`;
  }
  return `${Math.round(seconds / 1e-15)} fs`;
}

export function surferCursorMessage(raw: number) {
  const tick = Math.max(0, Math.round(raw));
  const digits: number[] = [];
  let remaining = tick;
  while (remaining > 0) {
    digits.push(remaining % 0x1_0000_0000);
    remaining = Math.floor(remaining / 0x1_0000_0000);
  }
  return JSON.stringify({ CursorSet: tick === 0 ? [0, []] : [1, digits] });
}
