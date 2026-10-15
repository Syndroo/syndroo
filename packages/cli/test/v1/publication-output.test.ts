import { Readable, Writable } from "node:stream";

import type { DeliveryResult, ExecutionResult, PreparedResult, TargetPreview } from "@syndroo/core";
import { describe, expect, it } from "vitest";

import type { CliIo } from "../../src/io.js";
import { renderPublication } from "../../src/render/publication.js";
import { createPublicationOutput } from "../../src/render/publication-output.js";
import { publicationView } from "../../src/render/publication-view.js";
import { displayWidth, graphemeWidth, graphemes } from "../../src/render/terminal-text.js";

/**
 * The publish output controller.
 *
 * It owns one publication block: in a redraw-capable terminal it updates the
 * block in place, anywhere else it appends. Everything here drives the
 * controller directly, so the stdout stream, the terminal size, resize, abort
 * and stream faults are all under the test's control.
 */

const ESC = "\u001b";

function sink() {
  const seen: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done): void {
      seen.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), "utf8"));
      done();
    },
  });

  return { stream, text: () => Buffer.concat(seen).toString("utf8") };
}

type IoOptions = {
  readonly stdoutIsTty?: boolean;
  /** A function when the test wants the width to change, as a resize does. */
  readonly columns?: number | (() => number | undefined);
  /** A function when the test wants the height to change, as a resize does. */
  readonly rows?: number | (() => number | undefined);
  readonly term?: string;
  readonly signal?: AbortSignal;
  readonly onResize?: (listener: () => void) => () => void;
};

function fakeIo(options: IoOptions = {}) {
  const out = sink();
  const err = sink();
  const env: NodeJS.ProcessEnv =
    options.term === undefined ? { NO_COLOR: "1" } : { NO_COLOR: "1", TERM: options.term };
  const rows = options.rows;
  const columns = options.columns;

  const io: CliIo = {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    env,
    cwd: process.cwd(),
    stdinIsTty: false,
    stdoutIsTty: options.stdoutIsTty ?? false,
    ...(typeof columns === "number" ? { columns } : {}),
    ...(typeof rows === "number" ? { rows } : {}),
    hasTty: () => false,
    readTtyLine: () => undefined,
    ...(options.onResize === undefined ? {} : { onResize: options.onResize }),
    signal: options.signal ?? new AbortController().signal,
  };

  // Object spread copies a getter's value, so a resizing height is installed
  // with `defineProperty` instead of a spread property.
  if (typeof rows === "function") {
    Object.defineProperty(io, "rows", { configurable: true, get: () => rows() });
  }

  if (typeof columns === "function") {
    Object.defineProperty(io, "columns", { configurable: true, get: () => columns() });
  }

  return { io, stdout: out.text, stderr: err.text };
}

const identity = (accountId: string, origin = "https://social.example") => ({
  provider: "fake",
  accountId,
  origin,
});

function target(over: Partial<TargetPreview> & { deliveryId: string }): TargetPreview {
  return {
    connectionId: "conn_1",
    account: identity("acct_1"),
    provider: "fake",
    preview: { content: { text: "A short body for the fixture." }, fields: [] },
    ...over,
  };
}

function delivery(over: Partial<DeliveryResult> & { deliveryId: string }): DeliveryResult {
  return {
    connectionId: "conn_1",
    account: identity("acct_1"),
    attempts: 1,
    outcome: null,
    preview: { content: { text: "A short body for the fixture." }, fields: [] },
    ...over,
  } as DeliveryResult;
}

function execution(
  deliveries: readonly DeliveryResult[],
  over: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    phase: "execution",
    operationId: "op_output_0001",
    status: "running",
    deliveries,
    ...over,
  };
}

const succeeded = { status: "succeeded" } as const;
const failed = {
  status: "failed",
  disposition: "not_applied",
  retryable: false,
  reason: "auth",
} as const;

function prepared(preview: readonly TargetPreview[]): PreparedResult {
  return {
    status: "confirmation_required",
    operationId: "op_output_0001",
    approvalToken: "token_output_0001",
    expiresAt: "2026-10-14T01:00:00.000Z",
    preview,
  };
}

const options = { verbose: false, full: false, color: false } as const;

const TTY = { stdoutIsTty: true, columns: 80, rows: 40, term: "xterm-256color" } as const;

describe("publication output — dynamic versus appended", () => {
  it("redraws in place only on a redraw-capable terminal", () => {
    const { io, stdout } = fakeIo(TTY);
    const output = createPublicationOutput(io, options);
    const view = publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live");

    output.update(view);
    output.update(view);
    output.finish(view);
    output.close();

    expect(stdout()).toContain(`${ESC}[?25l`);
    expect(stdout()).toContain(`${ESC}[?25h`);
    // The cursor moved back up to the start of the block for the later draws.
    expect(stdout()).toMatch(new RegExp(`${ESC}\\[\\d+A`));
  });

  it("appends plain text when stdout is not a terminal", () => {
    const { io, stdout } = fakeIo({ stdoutIsTty: false, columns: 80, rows: 40, term: "xterm-256color" });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "ready" })]), "live"));
    output.finish(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live"));
    output.close();

    expect(stdout()).not.toContain(ESC);
  });

  it("appends plain text on a dumb terminal", () => {
    const { io, stdout } = fakeIo({ ...TTY, term: "dumb" });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "ready" })]), "live"));
    output.finish(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live"));
    output.close();

    expect(stdout()).not.toContain(ESC);
  });

  it("appends plain text when the block is taller than the terminal", () => {
    const { io, stdout } = fakeIo({ ...TTY, rows: 4 });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "ready" })]), "live"));
    output.finish(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live"));
    output.close();

    expect(stdout()).not.toContain(ESC);
  });

  it("appends plain text when the terminal height cannot be read", () => {
    const { io, stdout } = fakeIo({ stdoutIsTty: true, columns: 80, term: "xterm-256color" });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "ready" })]), "live"));
    output.finish(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live"));
    output.close();

    expect(stdout()).not.toContain(ESC);
  });
});

describe("publication output — appended log", () => {
  const twoTargets = () => [
    delivery({ deliveryId: "d1", connectionId: "conn_1", state: "ready" }),
    delivery({
      deliveryId: "d2",
      connectionId: "conn_2",
      account: identity("acct_2"),
      state: "ready",
    }),
  ];

  it("shows the identities and content once, appends only changed status lines, then the final result", () => {
    const { io, stdout } = fakeIo({ stdoutIsTty: false, columns: 80 });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution(twoTargets()), "live"));

    const initial = stdout();

    expect(initial).toContain("Content:");
    expect(initial).toContain("  A short body for the fixture.");
    expect(initial.match(/Waiting/g)).toHaveLength(2);

    const firstBodyCount = initial.match(/A short body for the fixture\./g)?.length ?? 0;

    output.update(
      publicationView(
        execution([
          delivery({ deliveryId: "d1", connectionId: "conn_1", state: "in_flight" }),
          delivery({
            deliveryId: "d2",
            connectionId: "conn_2",
            account: identity("acct_2"),
            state: "ready",
          }),
        ]),
        "live",
      ),
    );

    const appended = stdout().slice(initial.length);

    expect(appended).toContain("Publishing");
    // Only the changed target is appended; the unchanged one is not repeated.
    expect(appended).not.toContain("Waiting");
    expect(stdout().match(/A short body for the fixture\./g)?.length ?? 0).toBe(firstBodyCount);

    output.finish(
      publicationView(
        execution(
          [
            delivery({ deliveryId: "d1", connectionId: "conn_1", outcome: succeeded }),
            delivery({
              deliveryId: "d2",
              connectionId: "conn_2",
              account: identity("acct_2"),
              outcome: failed,
            }),
          ],
          { status: "partial" },
        ),
        "live",
      ),
    );

    const tail = stdout().slice(initial.length + appended.length);

    expect(tail).toContain("Successful");
    expect(tail).toContain("Summary: 1 successful, 1 failed");
  });

  it("writes nothing when no status changed", () => {
    const { io, stdout } = fakeIo({ stdoutIsTty: false, columns: 80 });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution(twoTargets()), "live"));

    const before = stdout().length;

    output.update(publicationView(execution(twoTargets()), "live"));

    expect(stdout().length).toBe(before);
  });
});

describe("publication output — terminal restore and cleanup", () => {
  it("restores the cursor and removes its listeners on close", () => {
    let listeners = 0;
    const controller = new AbortController();
    const { io, stdout } = fakeIo({
      ...TTY,
      signal: controller.signal,
      onResize: (listener) => {
        listeners += 1;

        return () => {
          listeners -= 1;
        };
      },
    });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live"));

    expect(listeners).toBe(1);

    output.close();
    output.close();

    expect(listeners).toBe(0);
    expect(stdout().match(/\u001b\[\?25h/g)).toHaveLength(1);
  });

  it("degrades to plain appends after a resize makes the block too tall", () => {
    let height = 40;
    let resize: (() => void) | undefined;
    const { io, stdout } = fakeIo({
      ...TTY,
      rows: () => height,
      onResize: (listener) => {
        resize = listener;

        return () => {
          resize = undefined;
        };
      },
    });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live"));

    expect(stdout()).toContain(ESC);

    height = 2;
    resize?.();

    const before = stdout().length;

    output.update(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live"));

    expect(stdout().slice(before)).not.toContain(ESC);
  });
});

describe("publication output — stderr diagnostics", () => {
  it("keeps a diagnostic on stderr and redraws the block underneath it", () => {
    const { io, stdout, stderr } = fakeIo(TTY);
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live"));

    const before = stdout().length;

    output.diagnostic("a fixed safe diagnostic");

    expect(stderr()).toBe("syndroo: a fixed safe diagnostic\n");
    // The block is redrawn after the stderr write, so it is still on screen.
    expect(stdout().length).toBeGreaterThan(before);
    expect(stdout()).not.toContain("a fixed safe diagnostic");
  });
});

describe("publication output — fault isolation", () => {
  it("records a synchronously throwing stdout write and never rethrows into the caller", () => {
    const { io, stdout } = fakeIo({ stdoutIsTty: false, columns: 80 });

    // A closed pipe can throw straight out of `write()`, not only emit `error`.
    io.stdout.write = () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    };

    const output = createPublicationOutput(io, options);

    expect(() =>
      output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "ready" })]), "live")),
    ).not.toThrow();
    expect(() =>
      output.finish(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live")),
    ).not.toThrow();
    expect(() => output.close()).not.toThrow();
    expect(output.failed).toBe(true);
    expect(stdout()).toBe("");
  });

  it("still absorbs a stdout error that arrives after close", () => {
    const { io } = fakeIo(TTY);
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live"));
    output.close();

    // EPIPE on a real pipe is delivered asynchronously; a listener removed at
    // close would turn the late error into an uncaught exception.
    expect(() =>
      io.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(output.failed).toBe(true);
  });

  it("records an asynchronous stdout error and stops writing", () => {
    const { io, stdout } = fakeIo(TTY);
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live"));

    io.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(output.failed).toBe(true);

    const before = stdout().length;

    expect(() =>
      output.update(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live")),
    ).not.toThrow();
    expect(stdout().length).toBe(before);
    expect(() => output.close()).not.toThrow();
  });

  it("closes on abort and restores the terminal", () => {
    const controller = new AbortController();
    const { io, stdout } = fakeIo({ ...TTY, signal: controller.signal });
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live"));
    controller.abort();

    expect(stdout()).toContain(`${ESC}[?25h`);
    expect(() => output.close()).not.toThrow();
  });
});

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ERASE_DOWN = `${ESC}[J`;

/**
 * Replay the controller's control sequences onto a minimal visible screen.
 *
 * A captured byte stream cannot answer "is there stale text on screen" on its
 * own, so this tiny emulator applies the three things `paint` uses: the cursor
 * moves up over the whole previous block, everything below is erased, and the
 * new body is written where the cursor now is. What it reports is what a
 * terminal would show, which is what the design promises.
 *
 * `columns` models terminal auto-wrap. It counts characters rather than cells,
 * which is exact for these ASCII fixtures and is what makes a wrapped block
 * observable instead of only countable.
 */
function screen(text: string, columns = Number.POSITIVE_INFINITY): string[] {
  const lines: string[] = [];
  let row = 0;
  let index = 0;

  while (index < text.length) {
    if (text.startsWith(HIDE_CURSOR, index)) {
      index += HIDE_CURSOR.length;
      continue;
    }

    if (text.startsWith(SHOW_CURSOR, index)) {
      index += SHOW_CURSOR.length;
      continue;
    }

    if (text.startsWith(ERASE_DOWN, index)) {
      lines.length = Math.min(lines.length, row);
      index += ERASE_DOWN.length;
      continue;
    }

    const move = /^\u001b\[(\d+)A\r/.exec(text.slice(index));

    if (move !== null) {
      row = Math.max(0, row - Number(move[1]));
      index += move[0].length;
      continue;
    }

    if (text[index] === "\r") {
      index += 1;
      continue;
    }

    const end = text.indexOf("\n", index);
    const chunk = text.slice(index, end === -1 ? text.length : end);

    // Keep the grid dense: a blank body line is a real row on screen.
    lines[row] = lines[row] ?? "";

    for (const character of chunk) {
      if ((lines[row] as string).length >= columns) {
        row += 1;
        lines[row] = "";
      }

      lines[row] = `${lines[row] ?? ""}${character}`;
    }

    if (end === -1) {
      index = text.length;
    } else {
      row += 1;
      index = end + 1;
    }
  }

  return lines;
}

/** The rows a terminal of `columns` columns shows for rendered lines. */
function wrapRows(lines: readonly string[], columns: number): string[] {
  const rows: string[] = [];

  for (const line of lines) {
    if (line.length === 0) {
      rows.push("");

      continue;
    }

    for (let index = 0; index < line.length; index += columns) {
      rows.push(line.slice(index, index + columns));
    }
  }

  return rows;
}

/**
 * Rows a terminal shows for one line, wrapping grapheme by grapheme.
 *
 * A two-cell grapheme that does not fit the last single cell moves whole to the
 * next row, so this is the true height a plain `ceil(width / columns)` cannot
 * give. It exists only to prove the conservative fallback is not vacuous.
 */
function wrappedRows(line: string, columns: number): number {
  let rows = 1;
  let column = 0;

  for (const grapheme of graphemes(line)) {
    const size = graphemeWidth(grapheme);

    if (column > 0 && column + size > columns) {
      rows += 1;
      column = 0;
    }

    column += size;
  }

  return rows;
}

/**
 * Overflowing lines, terminal width and abort.
 *
 * The renderer returns logical lines; a terminal counts rows. A line that
 * reaches past the last column wraps, and its height is only provable while
 * every grapheme is a single cell: a two-cell grapheme that does not fit the
 * last single cell of an odd-width row defeats a plain `ceil(width / columns)`.
 * The controller therefore paints a wrapped single-cell block with the exact
 * `ceil` count and appends any block whose height it cannot prove, and these
 * tests observe both through a wrap-aware screen. They also prove an interrupt
 * cannot swallow the final result.
 */
describe("publication output — overflowing lines, width resize and abort", () => {
  const narrow = { stdoutIsTty: true, columns: 10, rows: 200, term: "xterm-256color" } as const;
  const account = identity("acct_1", `https://social.example/${"a".repeat(250)}`);
  const layout = { width: 10, verbose: false, full: false, color: false } as const;

  const inFlight = () =>
    publicationView(execution([delivery({ deliveryId: "d1", account, state: "in_flight" })]), "live");

  it("paints a wrapped single-cell block using the terminal's own row count", () => {
    const { io, stdout } = fakeIo(narrow);
    const output = createPublicationOutput(io, options);
    const view = inFlight();
    const body = renderPublication(view, layout);

    // Non-vacuous: the url line really does overflow the ten-column terminal,
    // and the wrapped block is much taller than its logical line count.
    expect(body.some((line) => line.length > 10)).toBe(true);
    expect(wrapRows(body, 10).length).toBeGreaterThan(body.length);

    output.update(view);
    output.update(view);
    output.close();

    // Every grapheme is one cell, so `ceil` is exactly what the terminal shows:
    // the block is painted, the rewind uses the wrapped row count, and the
    // visible screen is the wrapped body with nothing stale left behind it.
    expect(stdout()).toContain(ESC);
    expect(stdout()).toContain(`${ESC}[${wrapRows(body, 10).length}A`);
    expect(screen(stdout(), 10)).toEqual(wrapRows(body, 10));
  });

  it("appends an odd-width block whose wide grapheme cannot fill the last cell", () => {
    // Three two-cell CJK glyphs are six cells. `ceil(6 / 3) = 2` rows, but a
    // two-cell glyph cannot occupy the last single cell of a three-column row,
    // so a terminal may show three. Painting would need a cursor-up count the
    // controller cannot prove, so it appends instead.
    const wide = identity("acct_1", "中中中");
    const odd = { width: 3, verbose: false, full: false, color: false } as const;
    const view = publicationView(
      execution([delivery({ deliveryId: "d1", account: wide, state: "in_flight" })]),
      "live",
    );
    const lines = renderPublication(view, odd);
    const naive = lines.reduce(
      (rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / 3)),
      0,
    );
    const real = lines.reduce((rows, line) => rows + wrappedRows(line, 3), 0);

    // The measurement the fix removes under-counted the true height.
    expect(real).toBeGreaterThan(naive);

    const { io, stdout } = fakeIo({ stdoutIsTty: true, columns: 3, rows: 100, term: "xterm-256color" });
    const output = createPublicationOutput(io, options);

    // A plain `ceil` count fits a hundred rows and would have painted; the
    // controller refuses because the true height is not provable.
    expect(naive + 1).toBeLessThanOrEqual(100);

    output.update(view);
    output.close();

    expect(stdout()).not.toContain(ESC);
  });

  it("still paints the same wide-grapheme view when every line fits", () => {
    const wide = identity("acct_1", "中中中");
    const { io, stdout } = fakeIo(TTY);
    const output = createPublicationOutput(io, options);

    output.update(
      publicationView(execution([delivery({ deliveryId: "d1", account: wide, state: "in_flight" })]), "live"),
    );
    output.close();

    expect(stdout()).toContain(ESC);
  });

  it("stops painting instead of erasing with a stale row count after a width change", () => {
    let columns = 80;
    let resize: (() => void) | undefined;
    const { io, stdout } = fakeIo({
      stdoutIsTty: true,
      term: "xterm-256color",
      rows: 200,
      columns: () => columns,
      onResize: (listener) => {
        resize = listener;

        return () => {
          resize = undefined;
        };
      },
    });
    const output = createPublicationOutput(io, options);
    const short = publicationView(
      execution([delivery({ deliveryId: "d1", state: "in_flight" })]),
      "live",
    );

    output.update(short);

    const painted = stdout();

    expect(painted).toContain(ESC);

    columns = 40;
    resize?.();

    // A terminal reflows what is already on screen when its width changes, so
    // no cursor-up count measured before the resize is trustworthy: nothing may
    // be erased with it, and the round continues as an appended log.
    expect(stdout()).toBe(painted);

    output.update(short);

    expect(stdout().slice(painted.length)).not.toContain(ESC);
  });

  it("keeps the final result after an abort instead of swallowing it", () => {
    const controller = new AbortController();
    const { io, stdout } = fakeIo({ ...TTY, signal: controller.signal });
    const output = createPublicationOutput(io, options);
    const final = publicationView(
      execution(
        [delivery({ deliveryId: "d1", attempts: 1, state: "in_flight" })],
        { status: "unknown", durabilityWarning: "OUTCOME_NOT_DURABLE" },
      ),
      "live",
    );

    const live = publicationView(
      execution([delivery({ deliveryId: "d1", attempts: 1, state: "in_flight" })]),
      "live",
    );

    output.update(live);

    const painted = stdout();

    expect(painted).toContain(HIDE_CURSOR);

    controller.abort();

    // The cursor is given back, and the controller stays open.
    expect(stdout().slice(painted.length)).toContain(SHOW_CURSOR);
    expect(output.failed).toBe(false);

    output.update(live);

    // An interrupt never paints again: the rest of the round is appended.
    expect(stdout().slice(painted.length)).not.toContain(HIDE_CURSOR);

    output.finish(final);
    output.close();

    const text = stdout();

    // The interrupted round still reports what really happened: an unknown
    // target, the durability warning and the one operation query that follows.
    expect(text).toContain("Status:\n  Unknown");
    expect(text).toContain("Warning: the outcome could not be saved reliably");
    expect(text).toContain("syndroo status --operation op_output_0001 --verbose");
  });
});

describe("publication output — in-place redraw correctness", () => {
  const full = { verbose: true, full: true, color: false } as const;

  it("a shorter redraw replaces the taller block instead of leaving stale lines", () => {
    const { io, stdout } = fakeIo(TTY);
    const output = createPublicationOutput(io, full);
    const tall = publicationView(
      execution([
        delivery({ deliveryId: "d1", connectionId: "conn_1", state: "in_flight" }),
        delivery({
          deliveryId: "d2",
          connectionId: "conn_2",
          account: identity("acct_second_account"),
          state: "ready",
        }),
        delivery({
          deliveryId: "d3",
          connectionId: "conn_3",
          account: identity("acct_third_account"),
          state: "ready",
        }),
      ]),
      "live",
    );
    const short = publicationView(
      execution([delivery({ deliveryId: "d1", connectionId: "conn_1", outcome: succeeded })], {
        status: "succeeded",
      }),
      "live",
    );

    output.update(tall);
    output.finish(short);
    output.close();

    const visible = screen(stdout());
    const expected = renderPublication(short, { width: 80, verbose: true, full: true, color: false });
    const tallBody = renderPublication(tall, { width: 80, verbose: true, full: true, color: false });

    // The visible screen is exactly the final body: the taller block left no
    // trailing line behind the shrink.
    expect(tallBody.length).toBeGreaterThan(expected.length);
    expect(visible).toEqual(expected);
    expect(visible.join("\n")).not.toContain("acct_second_account");
    expect(visible.join("\n")).not.toContain("acct_third_account");
  });

  it("draws the first block below whatever is already on screen", () => {
    const { io, stdout } = fakeIo(TTY);
    const output = createPublicationOutput(io, options);

    output.update(publicationView(execution([delivery({ deliveryId: "d1", state: "in_flight" })]), "live"));
    output.update(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live"));
    output.finish(publicationView(execution([delivery({ deliveryId: "d1", outcome: succeeded })]), "live"));
    output.close();

    const text = stdout();
    const firstBody = text.indexOf("-> fake · acct_1");
    const firstMoveUp = text.search(/\u001b\[\d+A/);

    expect(firstBody).toBeGreaterThan(-1);
    // A first paint has no block of its own to rewind over, so it never moves
    // the cursor up: text printed before it (a preview on the same terminal)
    // stays untouched. Later paints do rewind over this block.
    expect(firstMoveUp).toBeGreaterThan(firstBody);
  });
});
