import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT } from "../../shared/topology";
import { parseArgs } from "./args";
import type { Env } from "./command";
import { createCli } from "./registry";

const cli = createCli(async () => {});

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bandar-config-command-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const file = (): string => join(home, "config.json");

type ServerSettings = {
  readonly port?: number;
  readonly authUrl?: string;
  readonly trustedOrigins?: readonly string[];
};

const write = (server: ServerSettings): void => {
  writeFileSync(file(), JSON.stringify({ server }));
};

type Run = {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
};

const run = async (argv: readonly string[], env: Env = {}): Promise<Run> => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const log = vi.spyOn(console, "log").mockImplementation((line: string) => {
    stdout.push(line);
  });

  const error = vi.spyOn(console, "error").mockImplementation((line: string) => {
    stderr.push(line);
  });

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const invocation = parseArgs(argv, cli);

    if (invocation.kind !== "command")
      throw new Error(`expected a command, got ${invocation.kind}`);

    const code = await invocation.command.run(
      { BANDAR_HOME: home, BANDAR_AUTH_SECRET: "set", ...env },
      invocation.args ?? [],
    );

    return { code, stdout, stderr };
  } finally {
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
};

const lineOf = (lines: readonly string[], label: string): string => {
  const line = lines.find((candidate) => candidate.startsWith(label));

  if (line === undefined) throw new Error(`no ${label} line in ${lines.join(" | ")}`);

  return line;
};

describe("the config command", () => {
  test("a missing file prints missing and the defaults", async () => {
    const { code, stdout, stderr } = await run(["config"]);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(5);

    const settings = lineOf(stdout, "settings");

    expect(settings).toContain(file());
    expect(settings.endsWith("(missing)")).toBe(true);

    expect(lineOf(stdout, "server.host").endsWith("0.0.0.0 (default)")).toBe(true);
    expect(lineOf(stdout, "server.port").endsWith(`${String(DEFAULT_API_PORT)} (default)`)).toBe(
      true,
    );
    expect(
      lineOf(stdout, "server.authUrl").endsWith(
        `http://localhost:${String(DEFAULT_API_PORT)} (default)`,
      ),
    ).toBe(true);

    const origins = lineOf(stdout, "trustedOrigins");

    expect(origins).toContain(`http://localhost:${String(DEFAULT_API_PORT)}`);
    expect(origins).toContain(`http://127.0.0.1:${String(DEFAULT_WEB_PORT)}`);
    expect(origins.endsWith("(default)")).toBe(true);
  });

  test("the file supplies the auth URL and the trusted origins", async () => {
    write({
      port: 4000,
      authUrl: "https://llm.example.com",
      trustedOrigins: ["https://LLM.example.com/", "https://alt.example.com"],
    });

    const { code, stdout } = await run(["config"]);

    expect(code).toBe(0);
    expect(lineOf(stdout, "settings").endsWith("(found)")).toBe(true);
    expect(lineOf(stdout, "server.port").endsWith("4000 (config.json)")).toBe(true);
    expect(lineOf(stdout, "server.authUrl").endsWith("https://llm.example.com (config.json)")).toBe(
      true,
    );
    expect(
      lineOf(stdout, "trustedOrigins").endsWith(
        "https://llm.example.com, https://alt.example.com (config.json)",
      ),
    ).toBe(true);
  });

  test("the environment prints as the source", async () => {
    write({
      authUrl: "https://file.example.com",
      trustedOrigins: ["https://file.example.com"],
    });

    const { stdout } = await run(["config"], {
      BANDAR_AUTH_URL: "https://env.example.com",
      BANDAR_TRUSTED_ORIGINS: "https://one.example.com, https://two.example.com",
    });

    expect(lineOf(stdout, "server.authUrl").endsWith("https://env.example.com (environment)")).toBe(
      true,
    );
    expect(
      lineOf(stdout, "trustedOrigins").endsWith(
        "https://one.example.com, https://two.example.com (environment)",
      ),
    ).toBe(true);
  });

  test("an argument exits 2", async () => {
    const { code, stdout, stderr } = await run(["config", "now"]);

    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["bandar config: takes no arguments"]);
  });

  test("an invalid file exits 1, naming the path and the field", async () => {
    write({ port: 70000 });

    const invalidPort = await run(["config"]);

    expect(invalidPort.code).toBe(1);
    expect(invalidPort.stdout).toEqual([]);
    expect(invalidPort.stderr).toHaveLength(1);

    const [line] = invalidPort.stderr;

    expect(line).toContain("bandar config:");
    expect(line).toContain(file());
    expect(line).toContain("server.port");
    expect(line).not.toContain("\n");

    writeFileSync(file(), '{"nope":true}');

    const unknownKey = await run(["config"]);

    expect(unknownKey.code).toBe(1);
    expect(unknownKey.stderr[0]).toContain(file());
    expect(unknownKey.stderr[0]).toContain("nope");
  });
});
