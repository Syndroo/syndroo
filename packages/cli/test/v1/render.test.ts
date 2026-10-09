import { ProtocolError } from "@syndroo/core";
import { describe, expect, it } from "vitest";

import {
  EXIT_CODE,
  classify,
  escapeControls,
  exitForExecution,
  staticMessage,
} from "../../src/index.js";

/**
 * The static rendering contract.
 *
 * Codes map to fixed exit families and fixed English, and control characters are
 * escaped before any styling is applied. None of this can carry a raw token,
 * path or response body into terminal output.
 */

describe("static rendering contract", () => {
  it("escapes control characters but preserves tab, newline and Unicode", () => {
    expect(escapeControls("tab\tnewline\nbell\u0007end")).toBe("tab\tnewline\nbell\\x07end");
    expect(escapeControls("exact 雨 text")).toBe("exact 雨 text");
  });

  it("answers with static text and never echoes an unknown code", () => {
    const message = staticMessage("SOME_UNKNOWN_CODE");

    expect(message).toBe("The command could not be completed.");
    expect(message).not.toContain("SOME_UNKNOWN_CODE");
  });

  it("maps failures to exit families by code, not by message", () => {
    expect(classify(new ProtocolError("CANCELLED"))).toEqual({
      code: "CANCELLED",
      exit: EXIT_CODE.INTERRUPTED,
    });
    expect(classify(new ProtocolError("STATE_RECOVERY_REQUIRED")).exit).toBe(EXIT_CODE.FAILURE);
    expect(classify(new ProtocolError("NOT_FOUND")).exit).toBe(EXIT_CODE.USAGE);
    expect(classify(new Error("boom"))).toEqual({ code: "INTERNAL", exit: EXIT_CODE.FAILURE });
  });

  it("keeps an unknown execution round non-retryable and non-successful", () => {
    expect(exitForExecution("unknown")).toBe(EXIT_CODE.AMBIGUOUS);
    expect(exitForExecution("failed")).toBe(EXIT_CODE.NOT_DELIVERED);
    expect(exitForExecution("partial")).toBe(EXIT_CODE.NOT_DELIVERED);
    expect(exitForExecution("succeeded")).toBe(EXIT_CODE.SUCCESS);
    expect(exitForExecution("pending")).toBe(EXIT_CODE.SUCCESS);
    expect(exitForExecution("running")).toBe(EXIT_CODE.SUCCESS);
  });
});
