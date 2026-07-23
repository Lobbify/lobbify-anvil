import { describe, expect, it } from "vitest";
import { MissingObject, SsrfBlocked } from "../../index.js";
import {
  EXIT_CODES,
  EXIT_ERROR,
  EXIT_INTERNAL,
  exitCodeFor,
  renderError,
} from "../../src/cli/errors.js";

function sink() {
  const out: string[] = [];
  return { w: { write: (s: string) => void out.push(s) }, text: () => out.join("") };
}

describe("CLI error rendering + exit codes", () => {
  it("maps taxonomy codes to their documented, stable exit codes", () => {
    expect(exitCodeFor("MISSING_OBJECT")).toBe(EXIT_CODES.MISSING_OBJECT);
    expect(exitCodeFor("SSRF_BLOCKED")).toBe(EXIT_CODES.SSRF_BLOCKED);
    expect(exitCodeFor("SHA_MISMATCH")).toBe(EXIT_CODES.SHA_MISMATCH);
    // An unknown code falls back to the generic error exit.
    expect(exitCodeFor("NOT_A_REAL_CODE")).toBe(EXIT_ERROR);
  });

  it("renders an AnvilError to stderr with an actionable hint (plain mode)", () => {
    const o = sink();
    const e = sink();
    const code = renderError(
      new MissingObject({ algo: "sha256", value: "abc123" }, "mod-x"),
      { stdout: o.w, stderr: e.w },
      false,
    );
    expect(code).toBe(EXIT_CODES.MISSING_OBJECT);
    expect(e.text()).toContain("error:");
    expect(e.text()).toContain("hint:");
    expect(o.text()).toBe(""); // nothing on stdout in plain mode
  });

  it("renders a single parseable JSON object in --json mode", () => {
    const o = sink();
    const e = sink();
    const code = renderError(
      new SsrfBlocked("http://169.254.169.254/latest", "resolves to a metadata address"),
      { stdout: o.w, stderr: e.w },
      true,
    );
    const parsed = JSON.parse(o.text().trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("SSRF_BLOCKED");
    expect(parsed.error.exitCode).toBe(code);
    expect(e.text()).toBe(""); // JSON mode is stdout-only
  });

  it("routes an unexpected (non-Anvil) error to the internal exit code", () => {
    const o = sink();
    const e = sink();
    const code = renderError(new Error("boom"), { stdout: o.w, stderr: e.w }, false);
    expect(code).toBe(EXIT_INTERNAL);
    expect(e.text().toLowerCase()).toContain("unexpected failure");
  });
});
