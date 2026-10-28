export type Env = Record<string, string | undefined>;

export type Command = {
  readonly name: string;
  readonly summary: string;
  readonly takesArguments?: boolean;
  readonly run: (env: Env, args: readonly string[]) => Promise<number>;
};

export type Cli = {
  readonly commands: readonly Command[];
  readonly fallback: Command;
};

export class Commands {
  readonly #byName = new Map<string, Command>();

  add(command: Command): void {
    if (this.#byName.has(command.name)) throw new Error(`duplicate command: ${command.name}`);

    this.#byName.set(command.name, command);
  }

  get all(): readonly Command[] {
    return [...this.#byName.values()];
  }
}

export async function notImplemented(name: string): Promise<number> {
  console.error(`${name} is not implemented in this build`);

  return 1;
}
