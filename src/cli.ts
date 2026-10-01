#!/usr/bin/env node
import { createIo, runCli } from "./cli/run";

const io = createIo(process.cwd());

// Ctrl+C during a session should exit cleanly rather than dumping a stack trace.
process.on("SIGINT", () => {
  io.writeLine();
  io.close();
  process.exit(130);
});

Promise.resolve(runCli(process.argv.slice(2), io)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    io.writeError(error instanceof Error ? error.message : String(error));
    io.close();
    process.exitCode = 1;
  },
);
