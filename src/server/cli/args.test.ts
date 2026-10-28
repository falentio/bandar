import { describe, expect, test } from "vite-plus/test";
import { parseArgs } from "./args";
import { createCli } from "./registry";

const cli = createCli(async () => {});
const serve = cli.fallback;

describe("parseArgs", () => {
  test("no arguments runs the fallback command", () => {
    expect(parseArgs([], cli)).toEqual({ kind: "command", command: serve });
  });

  test("serve runs the serve command", () => {
    expect(parseArgs(["serve"], cli)).toEqual({ kind: "command", command: serve });
  });

  test("--help and -h ask for usage", () => {
    expect(parseArgs(["--help"], cli)).toEqual({ kind: "help" });
    expect(parseArgs(["-h"], cli)).toEqual({ kind: "help" });
  });

  test("--version and -v ask for the version", () => {
    expect(parseArgs(["--version"], cli)).toEqual({ kind: "version" });
    expect(parseArgs(["-v"], cli)).toEqual({ kind: "version" });
  });

  test("an unknown command is invalid", () => {
    expect(parseArgs(["nope"], cli)).toEqual({ kind: "invalid", message: "unknown command: nope" });
  });

  test("an unknown flag is invalid", () => {
    expect(parseArgs(["--nope"], cli)).toEqual({
      kind: "invalid",
      message: "unknown option: --nope",
    });
  });

  test("an extra positional argument is invalid", () => {
    expect(parseArgs(["serve", "extra"], cli)).toEqual({
      kind: "invalid",
      message: "serve takes no arguments",
    });
  });
});
