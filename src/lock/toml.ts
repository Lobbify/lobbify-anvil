/**
 * Canonical TOML emit primitives for the owned, byte-stable lock writer.
 *
 * We do **not** delegate serialization to a TOML library: determinism (a
 * byte-identical lock cross-OS and cross-Node) requires that *we* control key
 * order, string escaping, integer formatting, and path separators. These
 * primitives are the whole surface the lock serializer builds strings from.
 *
 * Rules that make the output canonical:
 *   - every string is a TOML *basic* string (`"…"`) with one fixed escape table;
 *   - strings are NFC-normalized so a macOS-NFD input can't produce different
 *     bytes than a Linux-NFC one;
 *   - path-valued strings force `/` separators (never a Windows `\`);
 *   - integers are plain base-10 with no locale grouping and no `.0`.
 */

/** Escape one character for a TOML basic string, or return it unchanged. */
function escapeChar(ch: string): string {
  switch (ch) {
    case "\\":
      return "\\\\";
    case '"':
      return '\\"';
    case "\b":
      return "\\b";
    case "\t":
      return "\\t";
    case "\n":
      return "\\n";
    case "\f":
      return "\\f";
    case "\r":
      return "\\r";
    default: {
      const code = ch.codePointAt(0) ?? 0;
      // Control characters (U+0000–U+001F) and DEL (U+007F) must be escaped.
      if (code <= 0x1f || code === 0x7f) {
        return `\\u${code.toString(16).padStart(4, "0")}`;
      }
      return ch;
    }
  }
}

/** A canonical TOML basic string: NFC-normalized, fixed escapes, always quoted. */
export function tomlString(value: string): string {
  const normalized = value.normalize("NFC");
  let out = '"';
  for (const ch of normalized) {
    out += escapeChar(ch);
  }
  return `${out}"`;
}

/** A canonical TOML integer (base-10, no grouping, no fraction). */
export function tomlInt(value: number): string {
  if (!Number.isInteger(value)) {
    throw new RangeError(`not an integer: ${value}`);
  }
  // Avoid any locale/exponent formatting; base-10 via toString is stable.
  return value.toString(10);
}

/** Force POSIX `/` separators in a path-valued string, then quote it. */
export function tomlPath(value: string): string {
  return tomlString(value.split("\\").join("/"));
}

/** `key = <rendered>` — the caller passes an already-rendered TOML value. */
export function kv(key: string, rendered: string): string {
  return `${key} = ${rendered}`;
}

/**
 * A single-line inline table from `[key, renderedValue]` pairs, in the exact
 * order given (order is part of the canonical form, so callers pass a fixed one).
 */
export function inlineTable(entries: readonly (readonly [string, string])[]): string {
  const body = entries.map(([k, v]) => `${k} = ${v}`).join(", ");
  return `{ ${body} }`;
}
