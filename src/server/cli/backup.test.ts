import { describe, expect, test } from "vite-plus/test";
import { parseBackupArgs } from "./backup";

describe("parseBackupArgs", () => {
  test("takes no output path by default", () => {
    expect(parseBackupArgs([])).toEqual({ kind: "ok", out: null });
  });

  test("reads --out as a separate word or with an equals sign", () => {
    expect(parseBackupArgs(["--out", "/srv/backups"])).toEqual({
      kind: "ok",
      out: "/srv/backups",
    });
    expect(parseBackupArgs(["--out=/srv/nightly.zip"])).toEqual({
      kind: "ok",
      out: "/srv/nightly.zip",
    });
  });

  test("refuses a missing path", () => {
    expect(parseBackupArgs(["--out"])).toEqual({ kind: "invalid", message: "--out needs a path" });
    expect(parseBackupArgs(["--out="])).toEqual({ kind: "invalid", message: "--out needs a path" });
  });

  test("refuses an unknown option", () => {
    expect(parseBackupArgs(["--into", "/tmp"])).toEqual({
      kind: "invalid",
      message: "unknown option: --into",
    });
  });
});
