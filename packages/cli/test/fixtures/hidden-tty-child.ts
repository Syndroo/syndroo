/**
 * PTY fixture: read one hidden line through the real production seam.
 *
 * It mirrors the CLI's signal wiring (SIGINT/SIGTERM abort the shared signal)
 * and, in `SIGNAL` mode, sends itself an OS signal from an async timer while
 * the hidden read is waiting. A synchronous wait would never run that timer.
 */
import { spawnSync } from "node:child_process";

import { createProcessIo } from "@syndroo/cli";

const mode = process.argv[2] ?? "read";
const controller = new AbortController();

for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.once(name, () => {
    controller.abort();
  });
}

const io = createProcessIo(controller.signal);

/** The terminal settings as `stty` reports them on this pty. */
function terminalSettings(): string {
  const result = spawnSync("stty", ["-g"], {
    stdio: ["inherit", "pipe", "ignore"],
    encoding: "utf8",
  });

  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

if (mode === "echo-off") {
  // Start with echo already disabled: the seam must restore *this* state, not
  // force echo on.
  spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  process.stdout.write("ECHO_WAS_OFF\n");
}

// Captured after the optional pre-existing echo-off, so it is the exact state
// the seam must restore.
const before = terminalSettings();

if (mode === "signal" || mode === "signal-int") {
  setTimeout(() => {
    process.kill(process.pid, mode === "signal-int" ? "SIGINT" : "SIGTERM");
  }, 300);
}

// The marker is emitted only after the seam has disabled echo, so the driver's
// typed secret can never race the echo change.
const line = await io.readHiddenTtyLine?.(30_000, controller.signal, () => {
  process.stdout.write("ECHO_OFF\n");
});

// The seam restores the terminal in its own `finally`, before this line runs.
process.stdout.write("RESTORED\n");

const after = terminalSettings();

process.stdout.write(`TTY_SAME=${before === after ? "yes" : "no"}\n`);
process.stdout.write(`TTY_NONEMPTY=${before.length > 0 ? "yes" : "no"}\n`);
process.stdout.write(`TTY_BEFORE=${before}\n`);
process.stdout.write(`TTY_AFTER=${after}\n`);

if (controller.signal.aborted) {
  process.stdout.write("ABORTED\n");
  process.exit(130);
}

process.stdout.write(
  line === undefined ? "RESULT=none\n" : `RESULT=${line.length}\n`,
);

if (mode === "read") {
  // A second, ordinary read proves echo is back on: whatever is typed now is
  // echoed to the terminal.
  process.stdout.write("VISIBLE_READY\n");
  const visible = io.readTtyLine(5_000);

  process.stdout.write(
    visible === undefined ? "VISIBLE=none\n" : `VISIBLE=${visible.trim()}\n`,
  );
}

process.exit(0);
