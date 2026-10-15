import type { CliIo } from "../io.js";

import {
  DEFAULT_LAYOUT_COLUMNS,
  publicationTargetStatus,
  renderPublication,
} from "./publication.js";
import type { PublicationTargetView, PublicationView } from "./publication-view.js";
import { displayWidth, escapeSingleLine, graphemeWidth, graphemes } from "./terminal-text.js";

/**
 * The publish output controller.
 *
 * One publication is one block. Where the terminal can be redrawn safely the
 * block updates in place; anywhere else it is an appended log that shows each
 * target's identity and content once, appends only the status lines that
 * actually changed, and finishes with the complete result and summary.
 *
 * The controller is deliberately not a UI framework: it renders the shared
 * publication view through the shared renderer, so a status can never mean one
 * thing on the terminal and another in `status --operation`.
 *
 * Failures here are output failures, never publication facts. A stdout that
 * throws or emits `error` marks the controller failed and stops writing; the
 * caller decides the exit code, and what really happened stays in the state
 * store.
 */

export type PublicationOutputOptions = {
  readonly verbose: boolean;
  readonly full: boolean;
  readonly color: boolean;
  /** Deterministic clock, so a verbose expiry renders the same in a test. */
  readonly now?: string;
};

export type PublicationOutput = {
  /** Draw a not-yet-final view (a progress snapshot or a prepared preview). */
  update(view: PublicationView): void;
  /** Write a safe diagnostic to stderr without destroying the live block. */
  diagnostic(text: string): void;
  /** Draw the final view; the appended log prints the complete result here. */
  finish(view: PublicationView): void;
  /** Restore the terminal and drop the resize and abort listeners. Idempotent. */
  close(): void;
  /** `true` once a stdout write failed, so the caller can exit non-zero. */
  readonly failed: boolean;
};

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
/** Erase from the cursor to the end of the screen. */
const ERASE_DOWN = "\u001b[J";

/** Select Graphic Rendition: colour only, so it never changes a column count. */
const SGR = /\u001b\[[0-9;]*m/g;

/**
 * Physical rows one rendered line occupies, or `undefined` when the terminal's
 * own wrapping cannot be proven.
 *
 * A line that fits inside the terminal is exactly one row. One that reaches
 * past the last column wraps, and the row count is only predictable when every
 * grapheme is a single cell: a two-cell grapheme that cannot fill the last
 * single cell of an odd-width row moves whole to the next row in some terminals
 * and is clipped in others, so `ceil` cannot give its height. `ceil` is exact
 * for the single-cell case, and the ambiguous case is rejected instead of
 * guessed, so a painted block never depends on a wrapping model the controller
 * cannot prove. Colour escapes occupy no cell and are stripped first.
 */
function physicalRowsOf(line: string, columns: number): number | undefined {
  const visible = line.replace(SGR, "");
  const width = displayWidth(visible);

  if (width <= columns) {
    return 1;
  }

  if (graphemes(visible).some((grapheme) => graphemeWidth(grapheme) > 1)) {
    return undefined;
  }

  return Math.ceil(width / columns);
}

/** Total physical rows of a rendered block, or `undefined` when unprovable. */
function physicalRows(body: readonly string[], columns: number): number | undefined {
  let rows = 0;

  for (const line of body) {
    const lineRows = physicalRowsOf(line, columns);

    if (lineRows === undefined) {
      return undefined;
    }

    rows += lineRows;
  }

  return rows;
}

type Mode = "dynamic" | "appended";

export function createPublicationOutput(
  io: CliIo,
  options: PublicationOutputOptions,
): PublicationOutput {
  let failed = false;
  let closed = false;
  /** Set once the run was interrupted: painting stops for good. */
  let aborted = false;
  let mode: Mode | undefined;
  /** Height of the block currently drawn in place, in physical rows. */
  let height = 0;
  /** Width the current block was painted at, so a resize can invalidate it. */
  let paintedColumns: number | undefined;
  let drawn = false;
  let hidden = false;
  let view: PublicationView | undefined;
  /** Last status of each target, so an append only reports real changes. */
  let statuses: Map<string, string> | undefined;
  let unsubscribeResize: (() => void) | undefined;

  /**
   * One stdout write that can never escape.
   *
   * A closed or already-failed channel is a no-op: after EPIPE there is no
   * reader left, and re-writing would only repeat the same failure.
   */
  function write(text: string): boolean {
    if (failed || closed) {
      return false;
    }

    try {
      io.stdout.write(text);

      return true;
    } catch {
      failed = true;

      return false;
    }
  }

  function linesOf(next: PublicationView): string[] {
    return renderPublication(next, {
      width: layoutColumns(),
      verbose: options.verbose,
      full: options.full,
      color: options.color,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /**
   * The width the block is laid out for.
   *
   * A terminal that reports an unusable width (missing, zero or not a number)
   * is measured with the same 80-column fallback the renderer uses, so the
   * layout and the row count can never disagree about how wide the block is.
   */
  function layoutColumns(): number {
    const columns = io.columns;

    return columns === undefined || !Number.isFinite(columns) || columns <= 0
      ? DEFAULT_LAYOUT_COLUMNS
      : columns;
  }

  /**
   * Whether the block can be redrawn in place right now.
   *
   * Every condition fails closed: an unknown height, a dumb terminal, a block
   * taller than the screen or any line that would wrap all mean "append
   * instead of paint".
   */
  function redrawable(body: readonly string[]): boolean {
    if (io.stdoutIsTty !== true) {
      return false;
    }

    const term = io.env["TERM"];

    if (term === undefined || term === "" || term === "dumb") {
      return false;
    }

    const screenRows = io.rows;

    if (screenRows === undefined || !Number.isFinite(screenRows) || screenRows <= 0) {
      return false;
    }

    // The block is redrawn only when its physical height is provable and the
    // screen can hold it. One spare row keeps the committed final line from
    // scrolling the top of the block off the screen while it is still being
    // redrawn. An unprovable height degrades to the appended log, which needs
    // no cursor arithmetic at all.
    const rows = physicalRows(body, layoutColumns());

    return rows !== undefined && rows + 1 <= screenRows;
  }

  function subscribeResize(): void {
    if (unsubscribeResize !== undefined || io.onResize === undefined) {
      return;
    }

    try {
      unsubscribeResize = io.onResize(onResize);
    } catch {
      unsubscribeResize = undefined;
    }
  }

  function onResize(): void {
    if (mode !== "dynamic" || view === undefined || closed || aborted) {
      return;
    }

    const body = linesOf(view);

    // A real terminal reflows what is already on screen when its width
    // changes, so the stored row count no longer says where the block starts.
    // A width-preserving resize keeps that count valid; any other one stops
    // the in-place painting instead of erasing over the wrong rows.
    if (layoutColumns() === paintedColumns && redrawable(body)) {
      paint(body);

      return;
    }

    // The screen can no longer hold the block: stop painting. The next update
    // appends below what is already on screen, with no control sequences.
    mode = "appended";
    height = 0;
    paintedColumns = undefined;
    drawn = false;
  }

  function paint(body: readonly string[]): void {
    const rows = physicalRows(body, layoutColumns());

    // Every caller gates on `redrawable`, so this is unreachable; refusing to
    // paint is still safer than erasing with a height the terminal may not
    // agree with.
    if (rows === undefined) {
      return;
    }

    if (!hidden) {
      if (!write(HIDE_CURSOR)) {
        return;
      }

      hidden = true;
    }

    const move = height > 0 ? `\u001b[${height}A\r${ERASE_DOWN}` : "";

    if (!write(`${move}${body.join("\n")}\n`)) {
      return;
    }

    // The block is exactly as tall as the provable physical height, so a later
    // redraw rewinds over the rows the terminal really wrote.
    height = rows;
    paintedColumns = layoutColumns();
    drawn = true;
    subscribeResize();
  }

  function eraseBlock(): void {
    if (!drawn) {
      return;
    }

    write(`\u001b[${height}A\r${ERASE_DOWN}`);
    height = 0;
    drawn = false;
  }

  function append(next: PublicationView, body: readonly string[], final: boolean): void {
    const fresh = statuses === undefined;
    const previous = statuses ?? new Map<string, string>();
    // The status vocabulary is the renderer's, so ask it for each target.
    const current = new Map(
      next.targets.map((target) => [target.deliveryId, publicationTargetStatus(next, target)]),
    );

    view = next;

    statuses = current;

    if (final || fresh) {
      write(`${body.join("\n")}\n`);

      return;
    }

    const changed: string[] = [];

    for (const target of next.targets) {
      const status = current.get(target.deliveryId) as string;

      if (status !== previous.get(target.deliveryId)) {
        changed.push(`  ${escapeSingleLine(target.displayName)}: ${escapeSingleLine(status)}`);
      }
    }

    if (changed.length > 0) {
      write(`${changed.join("\n")}\n`);
    }
  }

  function render(next: PublicationView, final: boolean): void {
    if (closed || failed) {
      return;
    }

    view = next;

    const body = linesOf(next);

    // Once interrupted, nothing is painted again: the rest of the round is one
    // appended result. A final draw still has to reach the screen, which is why
    // aborting stops the painting and not the controller.
    if (mode === "appended" || aborted) {
      mode = "appended";
      append(next, body, final);

      return;
    }

    if (redrawable(body)) {
      mode = "dynamic";
      paint(body);

      return;
    }

    // Not paintable: degrade (or start) as an appended log.
    mode = "appended";
    append(next, body, final);
  }

  /**
   * A stdout fault only marks the output channel failed.
   *
   * It never touches a publication fact: the caller chooses the exit code and
   * the state store keeps the truth.
   */
  const onError = (): void => {
    failed = true;
  };

  /**
   * Give the terminal back and stop in-place painting, without closing.
   *
   * An interrupt must not swallow the round's real result: the interrupted
   * execution still ends in one durably recorded outcome, and dropping it would
   * hide an unknown target and the query line that follows it. Nothing is erased
   * either — the shell may have written its own line, and a resize may have
   * reflowed the block, so no cursor-up count is trustworthy any more.
   */
  function stopPainting(): void {
    try {
      unsubscribeResize?.();
    } catch {
      // A broken unsubscribe must not keep the process alive.
    }

    unsubscribeResize = undefined;

    if (hidden && !failed) {
      try {
        io.stdout.write(SHOW_CURSOR);
      } catch {
        failed = true;
      }
    }

    hidden = false;
    height = 0;
    paintedColumns = undefined;
    drawn = false;

    if (mode === "dynamic") {
      mode = "appended";
    }
  }

  const onAbort = (): void => {
    if (closed || aborted) {
      return;
    }

    aborted = true;
    stopPainting();
  };

  function close(): void {
    if (closed) {
      return;
    }

    closed = true;
    stopPainting();

    // The stdout error listener stays attached for the life of the process. A
    // real pipe reports EPIPE asynchronously, so detaching it here would turn a
    // late error into an uncaught exception; one bounded listener is cheaper
    // than crashing the CLI after the result was already committed.
    io.signal.removeEventListener("abort", onAbort);
  }

  io.stdout.on("error", onError);

  if (!io.signal.aborted) {
    io.signal.addEventListener("abort", onAbort);
  }

  return {
    update(next: PublicationView): void {
      render(next, false);
    },
    diagnostic(text: string): void {
      if (closed) {
        return;
      }

      if (mode === "dynamic") {
        eraseBlock();
      }

      try {
        io.stderr.write(`syndroo: ${text}\n`);
      } catch {
        failed = true;
      }

      // Repaint only at the width the block was laid out for. A width the
      // controller never saw a resize for must not be redrawn with a stale row
      // count.
      if (mode === "dynamic" && view !== undefined && layoutColumns() === paintedColumns) {
        const body = linesOf(view);

        // The body may have changed since the last paint, so re-prove it: an
        // unprovable height must not erase the block, and the next update
        // degrades to the appended log instead.
        if (redrawable(body)) {
          paint(body);
        }
      }
    },
    finish(next: PublicationView): void {
      render(next, true);
    },
    close,
    get failed(): boolean {
      return failed;
    },
  };
}
