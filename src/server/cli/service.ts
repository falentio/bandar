import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { parseConfig } from "../config";
import type { Commands, Env } from "./command";

export const UNIT_NAME = "bandar.service";

export const ENV_FILE_NAME = "bandar.env";

export const SYSTEM_UNIT_DIR = "/etc/systemd/system";

export const SYSTEM_DATA_DIR = "/var/lib/bandar";

// StateDirectory= names a directory under /var/lib, so the name and the default data dir agree.
const STATE_DIRECTORY = "bandar";

const DEFAULT_SCOPE = "user";
const KNOWN_FLAGS = new Set(["--scope", "--data-dir", "--port", "--binary", "--purge"]);
const DIRECTORY_MODE = 0o755;
const UNIT_FILE_MODE = 0o644;
const ENV_FILE_MODE = 0o600;
const MIN_PORT = 0;
const MAX_PORT = 65535;
const PREFIX = "bandar: ";
const CONFIG_ONLY_SECRET = "install-service reads the config for its paths";

// A value systemd or a shell reads back verbatim: no quoting, no expansions.
const BARE_VALUE = /^[A-Za-z0-9_%@+=:,./\\-]+$/u;

export type Scope = "user" | "system";

/** Everything the unit file says, with every path already absolute. */
export type UnitOptions = {
  readonly scope: Scope;
  readonly binary: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly duckdbPath: string;
  readonly port: number;
  readonly envFile: string;
  readonly user: string;
};

export type ServiceFlags = {
  readonly scope: Scope;
  readonly dataDir?: string;
  readonly port?: number;
  readonly binary?: string;
  readonly purge: boolean;
};

export type ServiceArguments =
  | { readonly kind: "flags"; readonly flags: ServiceFlags }
  | { readonly kind: "invalid"; readonly message: string };

export type ServiceInput = {
  readonly env: Env;
  readonly flags: ServiceFlags;
  readonly home: string;
  readonly currentUser: string;
  readonly execPath: string;
};

export type ServicePlan = UnitOptions & {
  readonly unitDir: string;
  readonly unitPath: string;
  readonly systemctl: readonly string[];
};

export type ServiceRequest = {
  readonly env: Env;
  readonly argv: readonly string[];
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly home?: string;
  readonly currentUser?: string;
  readonly execPath?: string;
  readonly isRoot?: boolean;
};

type Context = {
  readonly env: Env;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly home: string;
  readonly currentUser: string;
  readonly execPath: string;
  readonly isRoot: boolean;
};

export function renderUnit(options: UnitOptions): string {
  const operator =
    options.scope === "system"
      ? [`User=${unitValue(options.user)}`, `StateDirectory=${STATE_DIRECTORY}`]
      : [];

  return [
    "[Unit]",
    "Description=bandar, a self-hosted LLM gateway",
    "Documentation=https://github.com/falentio/bandar",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${unitValue(options.binary)} serve`,
    `WorkingDirectory=${unitValue(options.dataDir)}`,
    `Environment=${unitValue(`BANDAR_DB=${options.databasePath}`)}`,
    `Environment=${unitValue(`BANDAR_DUCKDB=${options.duckdbPath}`)}`,
    `Environment=${unitValue(`BANDAR_PORT=${String(options.port)}`)}`,
    // Last, so a value in the env file overrides the one baked in here.
    `EnvironmentFile=-${unitValue(options.envFile)}`,
    "Restart=on-failure",
    "RestartSec=5",
    ...operator,
    "",
    "[Install]",
    options.scope === "system" ? "WantedBy=multi-user.target" : "WantedBy=default.target",
    "",
  ].join("\n");
}

export function envFileTemplate(secret: string): string {
  return [
    "# bandar reads this file through EnvironmentFile= in bandar.service.",
    "# It signs every session, so it stays out of the world-readable unit.",
    "# Add any other BANDAR_* setting below; this file wins over the unit's Environment= lines.",
    `BANDAR_AUTH_SECRET=${secret}`,
    "",
  ].join("\n");
}

export function parseServiceArgs(argv: readonly string[], allowPurge: boolean): ServiceArguments {
  const values = new Map<string, string>();
  let purge = false;

  for (let index = 0; index < argv.length; index += 1) {
    const written = argv[index] ?? "";
    const [flag, inline] = splitFlag(written);

    if (flag === "--purge") {
      if (inline !== undefined) return invalid("--purge takes no value");

      if (!allowPurge) return invalid("--purge is not an option of this command");

      purge = true;

      continue;
    }

    if (!KNOWN_FLAGS.has(flag)) return invalid(`unknown option: ${written}`);

    let value = inline;

    if (value === undefined) {
      index += 1;
      value = argv[index];
    }

    if (value === undefined || value === "") return invalid(`${flag} needs a value`);

    values.set(flag, value);
  }

  const scope = values.get("--scope") ?? DEFAULT_SCOPE;

  if (scope !== "user" && scope !== "system")
    return invalid(`--scope must be user or system, not ${JSON.stringify(scope)}`);

  const writtenPort = values.get("--port");
  let port: number | undefined;

  if (writtenPort !== undefined) {
    port = Number(writtenPort);

    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)
      return invalid(
        `--port must be an integer between ${String(MIN_PORT)} and ${String(MAX_PORT)}`,
      );
  }

  return {
    kind: "flags",
    flags: {
      scope,
      purge,
      dataDir: values.get("--data-dir"),
      port,
      binary: values.get("--binary"),
    },
  };
}

export function planService(input: ServiceInput): ServicePlan {
  // The plan needs paths, not a session secret: the placeholder keeps parseConfig from warning
  // about a secret that no unit file would ever hold.
  const config = parseConfig({ BANDAR_AUTH_SECRET: CONFIG_ONLY_SECRET, ...input.env });
  const { scope } = input.flags;
  const dataDir = resolve(input.flags.dataDir ?? defaultDataDir(scope, input.env, input.home));
  const binary = resolve(input.flags.binary ?? input.execPath);
  const unitDir = scope === "user" ? userUnitDir(input.env, input.home) : SYSTEM_UNIT_DIR;

  return {
    scope,
    binary,
    dataDir,
    databasePath: besideDataDir(dataDir, config.databasePath),
    duckdbPath: besideDataDir(dataDir, config.duckdbPath),
    port: input.flags.port ?? config.port,
    user: operatorUser(input.env, input.currentUser),
    envFile: join(config.configDir, ENV_FILE_NAME),
    unitDir,
    unitPath: join(unitDir, UNIT_NAME),
    systemctl: scope === "user" ? ["--user"] : [],
  };
}

export async function installService(request: ServiceRequest): Promise<number> {
  const context = contextOf(request);
  const args = parseServiceArgs(request.argv, false);

  if (args.kind === "invalid") {
    context.stderr(`${PREFIX}${args.message}`);

    return 2;
  }

  if (args.flags.scope === "system" && !context.isRoot) {
    context.stderr(`${PREFIX}${sudoLine("install-service", args.flags, context.execPath)}`);

    return 1;
  }

  try {
    const plan = planService({
      env: context.env,
      flags: args.flags,
      home: context.home,
      currentUser: context.currentUser,
      execPath: context.execPath,
    });

    createDirectories(plan.unitDir);
    writeFileSync(plan.unitPath, renderUnit(plan), { mode: UNIT_FILE_MODE });

    const written = writeEnvFile(plan.envFile, randomBytes(32).toString("hex"));

    context.stderr(`${PREFIX}wrote ${plan.unitPath}`);
    context.stderr(
      written
        ? `${PREFIX}wrote ${plan.envFile}`
        : `${PREFIX}kept ${plan.envFile}, which already exists`,
    );

    for (const line of startCommands(plan)) context.stdout(line);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "the install failed";

    context.stderr(`${PREFIX}${message}`);

    return 1;
  }
}

export async function uninstallService(request: ServiceRequest): Promise<number> {
  const context = contextOf(request);
  const args = parseServiceArgs(request.argv, true);

  if (args.kind === "invalid") {
    context.stderr(`${PREFIX}${args.message}`);

    return 2;
  }

  if (args.flags.scope === "system" && !context.isRoot) {
    context.stderr(`${PREFIX}${sudoLine("uninstall-service", args.flags, context.execPath)}`);

    return 1;
  }

  try {
    const plan = planService({
      env: context.env,
      flags: args.flags,
      home: context.home,
      currentUser: context.currentUser,
      execPath: context.execPath,
    });

    if (args.flags.purge && isUnsafeToPurge(plan.dataDir, context.home)) {
      context.stderr(`${PREFIX}refusing to purge ${plan.dataDir}`);

      return 1;
    }

    if (existsSync(plan.unitPath)) {
      rmSync(plan.unitPath);
      context.stderr(`${PREFIX}removed ${plan.unitPath}`);
    } else {
      context.stderr(`${PREFIX}${plan.unitPath} was not installed`);
    }

    if (args.flags.purge) {
      rmSync(plan.dataDir, { recursive: true, force: true });
      rmSync(plan.envFile, { force: true });
      context.stderr(`${PREFIX}removed ${plan.dataDir} and ${plan.envFile}`);
    } else {
      context.stderr(
        `${PREFIX}kept ${plan.dataDir} and ${plan.envFile}; pass --purge to remove them`,
      );
    }

    for (const line of stopCommands(plan)) context.stdout(line);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "the uninstall failed";

    context.stderr(`${PREFIX}${message}`);

    return 1;
  }
}

export function register(commands: Commands): void {
  commands.add({
    name: "install-service",
    summary: "install bandar as a systemd service",
    run: (env) => installService({ env, argv: commandArgv("install-service") }),
  });

  commands.add({
    name: "uninstall-service",
    summary: "remove the bandar systemd service",
    run: (env) => uninstallService({ env, argv: commandArgv("uninstall-service") }),
  });
}

// The registry hands a command only the environment, so the flags come from the same argument
// slice args.ts parses: [binary, entry, command, ...flags].
function commandArgv(name: string): readonly string[] {
  const argv = Bun.argv.slice(2);

  return argv[0] === name ? argv.slice(1) : argv;
}

function splitFlag(written: string): readonly [string, string | undefined] {
  const separator = written.indexOf("=");

  if (separator === -1) return [written, undefined];

  return [written.slice(0, separator), written.slice(separator + 1)];
}

function invalid(message: string): ServiceArguments {
  return { kind: "invalid", message };
}

function systemctlLine(plan: ServicePlan, args: readonly string[]): string {
  return ["systemctl", ...plan.systemctl, ...args].join(" ");
}

function startCommands(plan: ServicePlan): readonly string[] {
  return [
    systemctlLine(plan, ["daemon-reload"]),
    systemctlLine(plan, ["enable", UNIT_NAME]),
    systemctlLine(plan, ["start", UNIT_NAME]),
    systemctlLine(plan, ["status", UNIT_NAME]),
  ];
}

function stopCommands(plan: ServicePlan): readonly string[] {
  return [
    systemctlLine(plan, ["disable", "--now", UNIT_NAME]),
    systemctlLine(plan, ["daemon-reload"]),
  ];
}

function sudoLine(command: string, flags: ServiceFlags, execPath: string): string {
  const argv = [execPath, command, "--scope", "system"];

  if (flags.dataDir !== undefined) argv.push("--data-dir", flags.dataDir);

  if (flags.port !== undefined) argv.push("--port", String(flags.port));

  if (flags.binary !== undefined) argv.push("--binary", flags.binary);

  if (flags.purge) argv.push("--purge");

  return `system scope needs root: sudo ${argv.map(shellArg).join(" ")}`;
}

function shellArg(value: string): string {
  if (BARE_VALUE.test(value)) return value;

  return `'${value.replaceAll("'", "'\\''")}'`;
}

// systemd expands %-specifiers inside quotes too, so one level of doubling is the escape.
function unitValue(value: string): string {
  const expanded = value.replaceAll("%", "%%");

  if (BARE_VALUE.test(expanded)) return expanded;

  return `"${expanded.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function setMode(path: string, mode: number): void {
  // chmod carries POSIX permission bits only: on Windows it toggles a read-only flag and can fail
  // on a share, so the modes stay a POSIX concern and a unit that systemd never reads is left as
  // the platform wrote it.
  if (process.platform === "win32") return;

  chmodSync(path, mode);
}

function createDirectories(dir: string): void {
  const missing: string[] = [];

  let current = dir;

  while (!existsSync(current)) {
    missing.unshift(current);
    current = dirname(current);
  }

  for (const path of missing) {
    mkdirSync(path, { mode: DIRECTORY_MODE });
    // A umask narrows the mode, and systemd refuses a unit below a directory only root can read.
    setMode(path, DIRECTORY_MODE);
  }
}

function writeEnvFile(path: string, secret: string): boolean {
  if (existsSync(path)) return false;

  createDirectories(dirname(path));
  // "wx" fails instead of clobbering, so a concurrent install cannot replace a live secret.
  writeFileSync(path, envFileTemplate(secret), { mode: ENV_FILE_MODE, flag: "wx" });
  setMode(path, ENV_FILE_MODE);

  return true;
}

function besideDataDir(dataDir: string, configured: string): string {
  return isAbsolute(configured) ? configured : join(dataDir, configured);
}

function defaultDataDir(scope: Scope, env: Env, home: string): string {
  if (scope === "system") return SYSTEM_DATA_DIR;

  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), STATE_DIRECTORY);
}

function userUnitDir(env: Env, home: string): string {
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user");
}

function operatorUser(env: Env, currentUser: string): string {
  const sudoUser = env.SUDO_USER;

  return sudoUser === undefined || sudoUser === "" ? currentUser : sudoUser;
}

// --purge removes a directory recursively, so the filesystem root and the home directory stay off
// limits even though both are reachable from legal flags.
function isUnsafeToPurge(dataDir: string, home: string): boolean {
  return dataDir === parse(dataDir).root || dataDir === home;
}

function contextOf(request: ServiceRequest): Context {
  return {
    env: request.env,
    stdout: request.stdout ?? console.log,
    stderr: request.stderr ?? console.error,
    home: request.home ?? homedir(),
    currentUser: request.currentUser ?? userInfo().username,
    execPath: request.execPath ?? process.execPath,
    isRoot: request.isRoot ?? process.getuid?.() === 0,
  };
}
