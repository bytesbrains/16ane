#!/usr/bin/env node
// npm bin wrapper: re-executes the TypeScript entry with type stripping.
import { spawn } from "node:child_process";
import path from "node:path";

const entry = path.resolve(import.meta.dirname, "../src/main.ts");
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
