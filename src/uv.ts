import { execFile } from "node:child_process";

/**
 * Safety gate for uv-dependent tide calculations.
 *
 * The FES spatial model path needs Python managed by uv on the Signal K host.
 * Before ever attempting it, the plugin checks that a usable `uv` exists. When
 * it does not, the fancy calculations are skipped entirely and the plugin
 * config surfaces how to install uv; the in-process station interpolation keeps
 * working without it.
 */

export interface UvStatus {
  available: boolean;
  version?: string;
}

export const UV_INSTALL_INSTRUCTIONS =
  "Install uv with: curl -LsSf https://astral.sh/uv/install.sh | sh " +
  "(then restart Signal K so the plugin finds it on PATH), " +
  "or see https://docs.astral.sh/uv/getting-started/installation/";

export const UV_CHECK_TIMEOUT_MS = 5000;

export type CheckRunner = (
  command: string,
  args: string[],
  callback: (error: Error | null, stdout: string) => void,
) => void;

const defaultRunner: CheckRunner = (command, args, callback) => {
  execFile(
    command,
    args,
    { timeout: UV_CHECK_TIMEOUT_MS },
    (error, stdout) => callback(error ? new Error(String(error)) : null, String(stdout)),
  );
};

let runner: CheckRunner = defaultRunner;
let cached: UvStatus | undefined;

/** Replace the exec mechanism (tests); pass undefined to restore the default. */
export function setUvCheckRunner(replacement: CheckRunner | undefined): void {
  runner = replacement ?? defaultRunner;
}

/** Test hook: forget the cached result so the next check runs again. */
export function resetUvCache(): void {
  cached = undefined;
}

/**
 * Check once per process whether `uv` is installed and runnable. The result is
 * cached because the answer cannot change while the server is running, and the
 * check is performed before any FES code path is attempted.
 */
export async function checkUv(): Promise<UvStatus> {
  if (cached) return cached;
  cached = await new Promise<UvStatus>((resolve) => {
    runner("uv", ["--version"], (error, stdout) => {
      resolve(
        error ? { available: false } : { available: true, version: stdout.trim() || undefined },
      );
    });
  });
  return cached;
}