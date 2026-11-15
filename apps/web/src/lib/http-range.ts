// Pure HTTP Range header parsing (single byte range; multi-range requests get the full body).

export type ByteRange = { start: number; end: number };

/**
 * Returns:
 * - null: no usable Range header -> serve the full file (200)
 * - "unsatisfiable": -> 416
 * - { start, end } (inclusive) -> 206
 */
export function parseRangeHeader(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) {
    return null;
  }
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!match) {
    return null;
  }
  const spec = match[1].trim();
  if (spec.includes(",")) {
    return null;
  }
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!parts || (parts[1] === "" && parts[2] === "")) {
    return null;
  }

  if (parts[1] === "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(parts[2], 10);
    if (suffix === 0 || size === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number.parseInt(parts[1], 10);
  let end = parts[2] === "" ? size - 1 : Number.parseInt(parts[2], 10);
  if (start >= size) {
    return "unsatisfiable";
  }
  if (end < start) {
    return null;
  }
  end = Math.min(end, size - 1);
  return { start, end };
}
