import { register as registerBackup } from "./backup";
import { Commands, type Cli, type Command, type Env } from "./command";
import { register as registerConfig } from "./config";
import { register as registerService } from "./service";
import { register as registerUpdate } from "./update";

export type Serve = (env: Env) => Promise<void>;

export function createCli(serve: Serve): Cli {
  const commands = new Commands();

  const serveCommand: Command = {
    name: "serve",
    summary: "serve the gateway; the default with no arguments",
    run: async (env) => {
      await serve(env);

      return 0;
    },
  };

  commands.add(serveCommand);
  registerBackup(commands);
  registerConfig(commands);
  registerService(commands);
  registerUpdate(commands);

  return { commands: commands.all, fallback: serveCommand };
}

export function renderUsage(cli: Cli): string {
  const width = Math.max(...cli.commands.map((command) => command.name.length));
  const rows = cli.commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);

  return [
    "usage: bandar [command]",
    "",
    "commands:",
    ...rows,
    "",
    "flags:",
    "  -h, --help     print this message",
    "  -v, --version  print the version",
  ].join("\n");
}
