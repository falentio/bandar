import {
  ConfigError,
  loadConfigReport,
  warnIfAuthSecretUnset,
  type ConfigReport,
  type ConfigSource,
} from "../config";
import { settingsIo } from "../settings-io";
import type { Commands, Env } from "./command";

const PREFIX = "bandar config: ";

const SOURCE_LABEL: Record<ConfigSource, string> = {
  environment: "environment",
  config: "config.json",
  default: "default",
  tailscale: "tailscale",
};

export function register(commands: Commands): void {
  commands.add({
    name: "config",
    summary: "write the schema beside the settings, then print the config it resolves",
    run: config,
  });
}

async function config(env: Env): Promise<number> {
  try {
    const report = loadConfigReport(env, settingsIo);

    warnIfAuthSecretUnset(env);

    for (const line of renderReport(report)) console.log(line);

    return 0;
  } catch (error) {
    // A ConfigError carries one entry per bad setting and a message that lists them on separate
    // lines; the command prints one line, so each entry is flattened and the list is joined again.
    const message =
      error instanceof ConfigError
        ? `${error.summary}: ${error.issues.map((issue) => oneLine(issue)).join("; ")}`
        : oneLine(error instanceof Error ? error.message : String(error));

    console.error(`${PREFIX}${message}`);

    return 1;
  }
}

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

function renderReport(report: ConfigReport): readonly string[] {
  const rows: readonly (readonly [string, string])[] = [
    ["settings", `${report.settingsPath} (${report.settingsFound ? "found" : "missing"})`],
    ["mode", report.mode],
    ...report.rows.map((row): readonly [string, string] => [
      row.key,
      `${row.value} (${SOURCE_LABEL[row.source]})`,
    ]),
  ];

  const width = Math.max(...rows.map(([label]) => label.length));

  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}
