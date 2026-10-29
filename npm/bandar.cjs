#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PACKAGES = new Map([
  ["linux-x64", { name: "bandar-linux-x64", asset: "linux", file: "bin/bandar", libc: "glibc" }],
  ["win32-x64", { name: "bandar-windows-x64", asset: "windows", file: "bin/bandar.exe" }],
]);

const INSTALLER =
  "curl -fsSL https://raw.githubusercontent.com/falentio/bandar/main/install.sh | sh";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function resolveBinary(platform, arch, resolve = require.resolve) {
  const key = `${platform}-${arch}`;
  const entry = PACKAGES.get(key);

  if (entry === undefined) {
    return {
      kind: "unsupported",
      reason: `bandar has no npm build for ${key}; npm ships ${[...PACKAGES.keys()].join(", ")}`,
    };
  }

  let manifest;

  try {
    manifest = resolve(`${entry.name}/package.json`);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;

    return {
      kind: "absent",
      reason: `npm did not install ${entry.name} for ${key}; run "npm install -g bandar@latest", or install with ${INSTALLER}`,
    };
  }

  const path = join(dirname(manifest), entry.file);

  if (!existsSync(path)) {
    return { kind: "absent", reason: `${entry.name} is installed without ${entry.file}` };
  }

  return { kind: "ready", path };
}

function launch(path, argv) {
  const child = spawn(path, argv, { stdio: "inherit", windowsHide: true });
  const forwarding = new Map();

  // Windows delivers a console Ctrl+C to every process already, so forwarding would signal the
  // child twice, and Node cannot raise a real SIGTERM there anyway.
  if (process.platform !== "win32") {
    for (const signal of SIGNALS) {
      const forward = () => child.kill(signal);

      forwarding.set(signal, forward);
      process.on(signal, forward);
    }
  }

  child.on("error", (error) => {
    process.stderr.write(`bandar: could not run ${path}: ${error.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    for (const [name, forward] of forwarding) process.off(name, forward);

    if (signal === null) {
      process.exit(code ?? 1);
    }

    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
  });
}

module.exports = { PACKAGES, resolveBinary };

if (require.main === module) {
  const target = resolveBinary(process.platform, process.arch);

  if (target.kind !== "ready") {
    process.stderr.write(`bandar: ${target.reason}\n`);
    process.exit(1);
  }

  launch(target.path, process.argv.slice(2));
}
