export const MAX_PREPROCESSED_BYTES = 2 * 1024 * 1024;
export const MAX_COMPILED_BYTES = 8 * 1024 * 1024;
export const MAX_VCD_BYTES = 12 * 1024 * 1024;
export const MAX_CONSOLE_CHARS = 128 * 1024;

export function boundedLines(limit = MAX_CONSOLE_CHARS) {
  const lines = [];
  let length = 0;
  let exceeded = false;
  return {
    push(line) {
      const input = String(line);
      if (length >= limit) { exceeded = true; return; }
      const value = input.slice(0, limit - length);
      if (value.length < input.length) exceeded = true;
      lines.push(value);
      length += value.length + 1;
    },
    text() { return lines.join("\n").slice(0, limit); },
    get length() { return Math.min(length, limit); },
    get exceeded() { return exceeded; },
  };
}

export function readBounded(runtime, path, maximum, label, options) {
  const size = runtime.FS.stat(path).size;
  if (size > maximum) throw new Error(`${label} exceeded the ${maximum / 1024 / 1024} MiB limit.`);
  return runtime.FS.readFile(path, options);
}
