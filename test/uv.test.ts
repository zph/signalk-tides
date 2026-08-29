import { describe, expect, it, beforeEach } from "vitest";
import {
  checkUv,
  resetUvCache,
  setUvCheckRunner,
  UV_INSTALL_INSTRUCTIONS,
  type CheckRunner,
} from "../src/uv.js";

describe("uv availability gate", () => {
  beforeEach(() => {
    resetUvCache();
  });

  it("reports availability when uv answers --version", async () => {
    const runner: CheckRunner = (_command, _args, callback) =>
      callback(null, "uv 0.8.4 (Homebrew)");
    setUvCheckRunner(runner);
    const status = await checkUv();
    expect(status.available).toBe(true);
    expect(status.version).toBe("uv 0.8.4 (Homebrew)");
    setUvCheckRunner(undefined);
  });

  it("reports unavailable when uv is not installed", async () => {
    const runner: CheckRunner = (_command, _args, callback) =>
      callback(new Error("ENOENT"), "");
    setUvCheckRunner(runner);
    const status = await checkUv();
    expect(status.available).toBe(false);
    setUvCheckRunner(undefined);
  });

  it("caches the result for the life of the process", async () => {
    let calls = 0;
    const runner: CheckRunner = (_command, _args, callback) => {
      calls += 1;
      callback(null, "uv 0.8.4");
    };
    setUvCheckRunner(runner);
    await checkUv();
    await checkUv();
    expect(calls).toBe(1);
    setUvCheckRunner(undefined);
  });

  it("ships install instructions for the config warning", () => {
    expect(UV_INSTALL_INSTRUCTIONS).toContain("https://astral.sh/uv");
  });
});