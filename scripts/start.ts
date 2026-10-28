import { BINARY } from "./binary";

const proc = Bun.spawn([BINARY], { stdio: ["inherit", "inherit", "inherit"] });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => proc.kill(signal));
}

process.exit(await proc.exited);
