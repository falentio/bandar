import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { DEFAULT_API_PORT } from "../../shared/topology";
import { parseArgs } from "./args";
import type { Env } from "./command";
import { createCli } from "./registry";
import {
  ENV_FILE_NAME,
  SYSTEM_DATA_DIR,
  SYSTEM_UNIT_DIR,
  UNIT_NAME,
  installService,
  parseServiceArgs,
  planService,
  renderUnit,
  uninstallService,
  type ServiceFlags,
  type ServiceRequest,
  type UnitOptions,
} from "./service";

const posix = test.skipIf(process.platform === "win32");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bandar-service-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const configDir = (): string => join(root, "config");

const envOf = (extra: Env = {}): Env => ({ BANDAR_CONFIG_DIR: configDir(), ...extra });

const planOf = (flags: Partial<ServiceFlags> = {}, extra: Env = {}) =>
  planService({
    env: envOf(extra),
    flags: { scope: "user", purge: false, ...flags },
    home: root,
    currentUser: "bandar",
    execPath: "/opt/bandar/bin/bandar",
  });

const unitPath = (): string => join(root, ".config", "systemd", "user", UNIT_NAME);

const envPath = (): string => join(configDir(), ENV_FILE_NAME);

const invoke = async (
  command: "install-service" | "uninstall-service",
  args: readonly string[] = [],
  options: { readonly isRoot?: boolean; readonly env?: Env } = {},
): Promise<{ code: number; stdout: string[]; stderr: string[] }> => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const request: ServiceRequest = {
    env: options.env ?? envOf(),
    args,
    home: root,
    currentUser: "bandar",
    execPath: "/opt/bandar/bin/bandar",
    isRoot: options.isRoot ?? false,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };

  const code =
    command === "install-service" ? await installService(request) : await uninstallService(request);

  return { code, stdout, stderr };
};

const flagsOf = (argv: readonly string[], allowPurge = false): ServiceFlags => {
  const args = parseServiceArgs(argv, allowPurge);

  if (args.kind !== "flags") throw new Error(`expected flags, got ${args.message}`);

  return args.flags;
};

const messageOf = (argv: readonly string[], allowPurge = false): string => {
  const args = parseServiceArgs(argv, allowPurge);

  if (args.kind !== "invalid") throw new Error("expected an invalid argument list");

  return args.message;
};

const modeOf = (path: string): number => statSync(path).mode & 0o777;

const systemOptions = (): UnitOptions => ({
  ...userOptions(),
  scope: "system",
  dataDir: "/var/lib/bandar",
  databasePath: "/var/lib/bandar/bandar.db",
  duckdbPath: "/var/lib/bandar/bandar.duckdb",
});

const userOptions = (): UnitOptions => ({
  scope: "user",
  binary: "/opt/bandar/bin/bandar",
  dataDir: "/home/andrew/.local/share/bandar",
  databasePath: "/home/andrew/.local/share/bandar/bandar.db",
  duckdbPath: "/home/andrew/.local/share/bandar/bandar.duckdb",
  port: 3000,
  envFile: "/home/andrew/.config/bandar/bandar.env",
  user: "andrew",
});

describe("renderUnit", () => {
  test("a user unit starts at default.target with no operator settings", () => {
    expect(renderUnit(userOptions())).toBe(`[Unit]
Description=bandar, a self-hosted LLM gateway
Documentation=https://github.com/falentio/bandar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/bandar/bin/bandar serve
WorkingDirectory=/home/andrew/.local/share/bandar
Environment=BANDAR_HOME=/home/andrew/.local/share/bandar
Environment=BANDAR_PORT=3000
EnvironmentFile=-/home/andrew/.config/bandar/bandar.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`);
  });

  test("a system unit names its user, claims a state directory, and starts at multi-user.target", () => {
    expect(renderUnit(systemOptions())).toBe(`[Unit]
Description=bandar, a self-hosted LLM gateway
Documentation=https://github.com/falentio/bandar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/bandar/bin/bandar serve
WorkingDirectory=/var/lib/bandar
Environment=BANDAR_HOME=/var/lib/bandar
Environment=BANDAR_PORT=3000
EnvironmentFile=-/home/andrew/.config/bandar/bandar.env
Restart=on-failure
RestartSec=5
User=andrew
StateDirectory=bandar

[Install]
WantedBy=multi-user.target
`);
  });

  test("a path with a space is quoted", () => {
    const unit = renderUnit({ ...userOptions(), dataDir: "/srv/bandar data" });

    expect(unit).toContain('WorkingDirectory="/srv/bandar data"');
  });

  test("a percent sign is doubled so systemd does not read it as a specifier", () => {
    const unit = renderUnit({ ...userOptions(), dataDir: "/srv/bandar%20data" });

    expect(unit).toContain("WorkingDirectory=/srv/bandar%%20data");
  });
});

describe("parseServiceArgs", () => {
  test("no flags is a user install", () => {
    expect(parseServiceArgs([], false)).toEqual({
      kind: "flags",
      flags: {
        scope: "user",
        purge: false,
        dataDir: undefined,
        port: undefined,
        binary: undefined,
      },
    });
  });

  test("every flag is read, with a space or an equals sign", () => {
    expect(
      flagsOf([
        "--scope",
        "system",
        "--data-dir",
        "/srv/bandar",
        "--port",
        "8080",
        "--binary",
        "/usr/local/bin/bandar",
      ]),
    ).toEqual({
      scope: "system",
      purge: false,
      dataDir: "/srv/bandar",
      port: 8080,
      binary: "/usr/local/bin/bandar",
    });

    expect(flagsOf(["--scope=user", "--port=1"])).toMatchObject({ scope: "user", port: 1 });
  });

  test("an unknown option is invalid", () => {
    expect(messageOf(["--nope"])).toBe("unknown option: --nope");
  });

  test("a flag without a value is invalid", () => {
    expect(messageOf(["--scope"])).toBe("--scope needs a value");
    expect(messageOf(["--data-dir", ""])).toBe("--data-dir needs a value");
  });

  test("a bad scope or port is invalid", () => {
    expect(messageOf(["--scope", "global"])).toContain("--scope must be user or system");
    expect(messageOf(["--port", "eighty"])).toContain("--port must be an integer");
    expect(messageOf(["--port", "80.5"])).toContain("--port must be an integer");
    expect(messageOf(["--port", "70000"])).toContain("--port must be an integer");
  });

  test("--purge belongs to uninstall only", () => {
    expect(messageOf(["--purge"], false)).toBe("--purge is not an option of this command");
    expect(flagsOf(["--purge"], true).purge).toBe(true);
    expect(messageOf(["--purge=yes"], true)).toBe("--purge takes no value");
  });
});

describe("planService", () => {
  test("a user install lands in ~/.config/systemd/user with data in ~/.local/share", () => {
    const plan = planOf();

    expect(plan.unitPath).toBe(unitPath());
    expect(plan.envFile).toBe(envPath());
    expect(plan.dataDir).toBe(join(root, ".local", "share", "bandar"));
    expect(plan.databasePath).toBe(join(plan.dataDir, "bandar.db"));
    expect(plan.duckdbPath).toBe(join(plan.dataDir, "bandar.duckdb"));
    expect(plan.port).toBe(DEFAULT_API_PORT);
    expect(plan.systemctl).toEqual(["--user"]);
  });

  test("a system install lands in /etc with data in /var/lib and the sudo user", () => {
    const plan = planOf({ scope: "system" }, { SUDO_USER: "andrew" });

    expect(plan.unitPath).toBe(join(SYSTEM_UNIT_DIR, UNIT_NAME));
    expect(plan.dataDir).toBe(SYSTEM_DATA_DIR);
    expect(plan.databasePath).toBe(join(SYSTEM_DATA_DIR, "bandar.db"));
    expect(plan.user).toBe("andrew");
    expect(plan.systemctl).toEqual([]);
  });

  test("a system install run as root itself names root", () => {
    expect(planOf({ scope: "system" }).user).toBe("bandar");
  });

  test("XDG_CONFIG_HOME and XDG_DATA_HOME move the user unit and its data", () => {
    const plan = planOf(
      {},
      { XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data") },
    );

    expect(plan.unitPath).toBe(join(root, "xdg-config", "systemd", "user", UNIT_NAME));
    expect(plan.dataDir).toBe(join(root, "xdg-data", "bandar"));
  });

  test("--data-dir moves both databases with it", () => {
    const plan = planOf({ dataDir: join(root, "data") });

    expect(plan.dataDir).toBe(join(root, "data"));
    expect(plan.databasePath).toBe(join(root, "data", "bandar.db"));
    expect(plan.duckdbPath).toBe(join(root, "data", "bandar.duckdb"));
  });

  test("BANDAR_DB and BANDAR_DUCKDB leave the unit's paths alone", () => {
    const plan = planOf({}, { BANDAR_DB: "/srv/keep.db", BANDAR_DUCKDB: "/srv/keep.duckdb" });

    expect(plan.databasePath).toBe(join(plan.dataDir, "bandar.db"));
    expect(plan.duckdbPath).toBe(join(plan.dataDir, "bandar.duckdb"));
  });

  test("--port and --binary override the config and the running binary", () => {
    const plan = planOf({ port: 8080, binary: "/usr/local/bin/bandar" });

    expect(plan.port).toBe(8080);
    expect(plan.binary).toBe("/usr/local/bin/bandar");
  });

  test("a relative --data-dir resolves against the working directory", () => {
    expect(planOf({ dataDir: "bandar-data" }).dataDir).toBe(join(process.cwd(), "bandar-data"));
  });

  test("the config parser rejects a bad environment", () => {
    expect(() => planOf({}, { BANDAR_PORT: "90000" })).toThrow("invalid environment");
  });
});

describe("installService", () => {
  test("a user install writes the unit and an env template, then prints four commands", async () => {
    const { code, stdout, stderr } = await invoke("install-service");

    expect(code).toBe(0);
    expect(stdout).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable bandar.service",
      "systemctl --user start bandar.service",
      "systemctl --user status bandar.service",
    ]);
    expect(stderr).toEqual([`bandar: wrote ${unitPath()}`, `bandar: wrote ${envPath()}`]);
    expect(readFileSync(unitPath(), "utf8")).toBe(renderUnit(planOf()));
  });

  test("a fresh install creates the directory the unit names as its working directory", async () => {
    await invoke("install-service");

    const unit = readFileSync(unitPath(), "utf8");
    // Read the path out of the unit itself, so the mkdir and the rendered directive cannot drift.
    const workingDirectory = /^WorkingDirectory=(.+)$/mu.exec(unit)?.[1] ?? "";

    expect(workingDirectory).toBe(join(root, ".local", "share", "bandar"));
    expect(existsSync(workingDirectory)).toBe(true);
  });

  posix("the unit directory is 755 and the unit is 644", async () => {
    await invoke("install-service");

    expect(modeOf(join(root, ".config", "systemd", "user"))).toBe(0o755);
    expect(modeOf(join(root, ".config", "systemd"))).toBe(0o755);
    expect(modeOf(unitPath())).toBe(0o644);
  });

  posix("the env template is mode 600 with a generated secret", async () => {
    await invoke("install-service");

    expect(modeOf(envPath())).toBe(0o600);
    expect(readFileSync(envPath(), "utf8")).toMatch(/^BANDAR_AUTH_SECRET=[0-9a-f]{64}$/mu);
  });

  test("an existing env file is never overwritten", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(envPath(), "BANDAR_AUTH_SECRET=keep-me\n");

    const { code, stderr } = await invoke("install-service");

    expect(code).toBe(0);
    expect(readFileSync(envPath(), "utf8")).toBe("BANDAR_AUTH_SECRET=keep-me\n");
    expect(stderr[1]).toBe(`bandar: kept ${envPath()}, which already exists`);
  });

  test("--data-dir, --port, and --binary reach the unit", async () => {
    const data = join(root, "data");

    const { code } = await invoke("install-service", [
      "--data-dir",
      data,
      "--port",
      "8080",
      "--binary",
      "/usr/local/bin/bandar",
    ]);

    const unit = readFileSync(unitPath(), "utf8");

    expect(code).toBe(0);
    expect(unit).toContain("ExecStart=/usr/local/bin/bandar serve");
    expect(unit).toContain(`WorkingDirectory=${data}`);
    expect(unit).toContain(`Environment=BANDAR_HOME=${data}`);
    expect(unit).toContain("Environment=BANDAR_PORT=8080");
  });

  test("BANDAR_CONFIG_DIR moves the env file", async () => {
    const elsewhere = join(root, "elsewhere");

    const { code } = await invoke("install-service", [], {
      env: envOf({ BANDAR_CONFIG_DIR: elsewhere }),
    });

    expect(code).toBe(0);
    expect(readFileSync(join(elsewhere, ENV_FILE_NAME), "utf8")).toContain("BANDAR_AUTH_SECRET=");
  });

  test("a system install without root names the sudo line and writes nothing", async () => {
    const { code, stdout, stderr } = await invoke("install-service", ["--scope", "system"]);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "bandar: system scope needs root: sudo /opt/bandar/bin/bandar install-service --scope system",
    ]);
    expect(existsSync(join(root, ".config"))).toBe(false);
    expect(existsSync(configDir())).toBe(false);
  });

  test("the sudo line carries every flag it was given, quoted for a shell", async () => {
    const { stderr } = await invoke("install-service", [
      "--scope",
      "system",
      "--data-dir",
      "/srv/bandar data",
      "--port",
      "8080",
    ]);

    expect(stderr[0]).toBe(
      "bandar: system scope needs root: sudo /opt/bandar/bin/bandar install-service --scope system " +
        "--data-dir '/srv/bandar data' --port 8080",
    );
  });

  test("an unknown option exits 2 and writes nothing", async () => {
    const { code, stderr } = await invoke("install-service", ["--nope"]);

    expect(code).toBe(2);
    expect(stderr).toEqual(["bandar: unknown option: --nope"]);
    expect(existsSync(join(root, ".config"))).toBe(false);
  });

  test("an invalid environment is one line on stderr", async () => {
    const { code, stderr } = await invoke("install-service", [], {
      env: envOf({ BANDAR_PORT: "90000" }),
    });

    expect(code).toBe(1);
    expect(stderr[0]).toContain("bandar: invalid environment");
  });
});

describe("uninstallService", () => {
  const seedData = (dataDir: string): void => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "bandar.db"), "");
  };

  test("it removes the unit and keeps the data and the env file", async () => {
    const data = join(root, "data");

    await invoke("install-service", ["--data-dir", data]);
    seedData(data);

    const { code, stdout, stderr } = await invoke("uninstall-service", ["--data-dir", data]);

    expect(code).toBe(0);
    expect(stdout).toEqual([
      "systemctl --user disable --now bandar.service",
      "systemctl --user daemon-reload",
    ]);
    expect(stderr[0]).toBe(`bandar: removed ${unitPath()}`);
    expect(stderr[1]).toBe(`bandar: kept ${data} and ${envPath()}; pass --purge to remove them`);
    expect(existsSync(unitPath())).toBe(false);
    expect(existsSync(join(data, "bandar.db"))).toBe(true);
    expect(existsSync(envPath())).toBe(true);
  });

  test("--purge removes the data and the env file too", async () => {
    const data = join(root, "data");

    await invoke("install-service", ["--data-dir", data]);
    seedData(data);

    const { code, stderr } = await invoke("uninstall-service", ["--purge", "--data-dir", data]);

    expect(code).toBe(0);
    expect(stderr[1]).toBe(`bandar: removed ${data} and ${envPath()}`);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(envPath())).toBe(false);
  });

  test("--purge refuses the home directory", async () => {
    const { code, stderr } = await invoke("uninstall-service", ["--purge", "--data-dir", root]);

    expect(code).toBe(1);
    expect(stderr).toEqual([`bandar: refusing to purge ${root}`]);
    expect(existsSync(root)).toBe(true);
  });

  test("uninstalling what was never installed still prints the commands", async () => {
    const { code, stderr, stdout } = await invoke("uninstall-service");

    expect(code).toBe(0);
    expect(stderr[0]).toBe(`bandar: ${unitPath()} was not installed`);
    expect(stdout).toEqual([
      "systemctl --user disable --now bandar.service",
      "systemctl --user daemon-reload",
    ]);
  });

  test("a system uninstall without root refuses and touches nothing", async () => {
    const { code, stdout, stderr } = await invoke("uninstall-service", ["--scope", "system"]);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "bandar: system scope needs root: sudo /opt/bandar/bin/bandar uninstall-service --scope system",
    ]);
    expect(existsSync(join(root, ".config"))).toBe(false);
  });
});

describe("the cli seam", () => {
  const cli = createCli(async () => {});
  const byName = new Map(cli.commands.map((command) => [command.name, command]));

  test("both service commands declare that they take arguments", () => {
    expect(byName.get("install-service")?.takesArguments).toBe(true);
    expect(byName.get("uninstall-service")?.takesArguments).toBe(true);
    expect(byName.get("serve")?.takesArguments).toBeUndefined();
  });

  test("the flags arrive as arguments instead of a usage error", () => {
    expect(parseArgs(["install-service", "--scope", "user", "--port", "8080"], cli)).toMatchObject({
      kind: "command",
      args: ["--scope", "user", "--port", "8080"],
    });
    expect(parseArgs(["uninstall-service", "--purge"], cli)).toMatchObject({
      kind: "command",
      args: ["--purge"],
    });
  });

  test("a command without takesArguments still rejects a stray option", () => {
    expect(parseArgs(["serve", "--scope", "user"], cli)).toEqual({
      kind: "invalid",
      message: "unknown option: --scope",
    });
    expect(parseArgs(["serve", "extra"], cli)).toEqual({
      kind: "invalid",
      message: "serve takes no arguments",
    });
  });
});
