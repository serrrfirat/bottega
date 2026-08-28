import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSIONS_MOUNT_PATH, assertWritableExtensionsDir } from "./extensions-writability";
describe("extensions mount boot probe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-only config/extensions emits an actionable diagnostic naming the exact mount", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-extensions-readonly-"));
    tempDirs.push(dir);
    chmodSync(dir, 0o555);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      expect(() => assertWritableExtensionsDir(dir)).toThrow(/not writable/);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain(EXTENSIONS_MOUNT_PATH);
    expect(errors.join("\n")).toContain("config/extensions");
  });

  test("writable config/extensions emits no diagnostic", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-extensions-writable-"));
    tempDirs.push(dir);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      expect(() => assertWritableExtensionsDir(dir)).not.toThrow();
    } finally {
      console.error = originalError;
    }
    expect(errors).toEqual([]);
  });
});

