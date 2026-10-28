import type { Cli, Command } from "./command";

export type Invocation =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "command"; readonly command: Command; readonly args?: readonly string[] }
  | { readonly kind: "invalid"; readonly message: string };

const FLAG_INVOCATIONS = new Map<string, Invocation>([
  ["-h", { kind: "help" }],
  ["--help", { kind: "help" }],
  ["-v", { kind: "version" }],
  ["--version", { kind: "version" }],
]);

export function parseArgs(argv: readonly string[], cli: Cli): Invocation {
  for (const arg of argv) {
    const invocation = FLAG_INVOCATIONS.get(arg);

    if (invocation !== undefined) return invocation;
  }

  const [head, ...rest] = argv;

  if (head === undefined) return { kind: "command", command: cli.fallback };

  if (head.startsWith("-")) return invalid(`unknown option: ${head}`);

  const command = cli.commands.find((candidate) => candidate.name === head);

  if (command === undefined) return invalid(`unknown command: ${head}`);

  if (command.takesArguments !== true) {
    const stray = rest.find((arg) => arg.startsWith("-"));

    if (stray !== undefined) return invalid(`unknown option: ${stray}`);

    if (rest.length > 0) return invalid(`${command.name} takes no arguments`);
  }

  if (rest.length === 0) return { kind: "command", command };

  return { kind: "command", command, args: rest };
}

function invalid(message: string): Invocation {
  return { kind: "invalid", message };
}
