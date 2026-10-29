import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.90.57.79"] },
});

/**
 * vp runs the suite on Bun and puts a bun-backed `node` first on PATH, so the runtime that reads
 * `vite.config.ts` is found by asking each candidate whether it has a `Bun` global.
 */
function nodeRuntime(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "node");

    if (!existsSync(candidate)) continue;

    const probe = spawnSync(candidate, ["-e", "process.stdout.write(String(typeof Bun))"], {
      encoding: "utf8",
    });

    if (probe.stdout === "undefined") return candidate;
  }

  throw new Error("no Node runtime on PATH to read the vite config");
}

// No runner has a tailnet, so the CLI is doubled at the process boundary the config reads it from.
function fakeTailscale(): string {
  const directory = mkdtempSync(join(tmpdir(), "bandar-tailscale-"));

  writeFileSync(join(directory, "tailscale"), `#!/bin/sh\nprintf '%s' '${STATUS}'\n`, {
    mode: 0o755,
  });

  return directory;
}

describe("the vite config", () => {
  test("it loads under node, the runtime vp reads it in", () => {
    const home = mkdtempSync(join(tmpdir(), "bandar-node-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: { tailscale: true } }));

    const bin = fakeTailscale();

    const result = spawnSync(
      nodeRuntime(),
      [join(root, "node_modules/.bin/vp"), "check", "--no-lint", "vite.config.ts"],
      {
        cwd: root,
        env: {
          ...process.env,
          BANDAR_HOME: home,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.status, result.stderr + result.stdout).toBe(0);
  });
});
