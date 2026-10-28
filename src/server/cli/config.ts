import { readFileSync } from "node:fs";
import { loadConfigReport, type ConfigReport, type ConfigSource } from "../config";
import type { Commands, Env } from "./command";

const PREFIX = "bandar config: ";

const SOURCE_LABEL: Record<ConfigSource, string> = {
  environment: "environment",
  config: "config.json",
  default: "default",
};

export function register(commands: Commands): void {
  commands.add({
    name: "config",
    summary: "print the settings file and the config it resolves",
    takesArguments: true,
    run: config,
  });
}

async function config(env: Env, args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    console.error(`${PREFIX}takes no arguments`);

    return 2;
  }

  try {
    const report = loadConfigReport(env, (path) => readFileSync(path, "utf8"));

    for (const line of renderReport(report)) console.log(line);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`${PREFIX}${message.replace(/\s+/gu, " ").trim()}`);

    return 1;
  }
}

export function renderReport(report: ConfigReport): readonly string[] {
  const rows: readonly (readonly [string, string])[] = [
    ["settings", `${report.settingsPath} (${report.settingsFound ? "found" : "missing"})`],
    ["server.host", `${report.config.host} (${SOURCE_LABEL[report.sources.host]})`],
    ["server.port", `${String(report.config.port)} (${SOURCE_LABEL[report.sources.port]})`],
    ["server.authUrl", `${report.config.authUrl} (${SOURCE_LABEL[report.sources.authUrl]})`],
    [
      "trustedOrigins",
      `${report.config.trustedOrigins.join(", ")} (${SOURCE_LABEL[report.sources.trustedOrigins]})`,
    ],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));

  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}
