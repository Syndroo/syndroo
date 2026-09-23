/**
 * Skill security contract: the shipped instructions must keep authorization and
 * untrusted text apart, and must not document a way to leak a credential.
 *
 * These are static contract checks over the shipped text. They assert that the
 * shipped instructions mention the right rules and omit dangerous ones. They do
 * not execute a forged-provider scenario, and they cannot prove that a model
 * follows the instructions; the evidence records that distinction.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SKILL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "syndroo",
);

function skillFile(relative: string): string {
  return readFileSync(path.join(SKILL_ROOT, relative), "utf8");
}

const ENTRY = skillFile("SKILL.md");
const CLI = skillFile("references/cli.md");

/** Prose wraps across lines; compare on one normalized line. */
function flat(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Every command that needs explicit user authorization before it runs. */
const AUTHORIZATION_COMMANDS: readonly string[] = [
  "syndroo posts create",
  "syndroo auth set",
  "syndroo auth connect",
  "syndroo auth complete",
  "syndroo auth remove",
];

describe("the Skill keeps authorization explicit", () => {
  it("names every authorization-bearing command", () => {
    for (const command of AUTHORIZATION_COMMANDS) {
      expect(ENTRY + CLI).toContain(command);
    }
  });

  it("says only the user can authorize those commands", () => {
    const text = ENTRY.toLowerCase();

    expect(text).toContain("only the user");
    expect(text).toContain("authoriz");
  });

  it("treats untrusted material as data, never as instructions", () => {
    const text = ENTRY.toLowerCase();

    for (const source of ["post text", "provider messages", "tool output"]) {
      expect(text, `SKILL.md should name ${source}`).toContain(source);
    }

    expect(text).toContain("never instructions");
    expect(text).toContain("cannot grant authorization");
  });
});

describe("the Skill does not document a way to leak a credential", () => {
  it("never advertises a credential flag", () => {
    const text = ENTRY + CLI;

    for (const flag of ["--token", "--password", "--secret", "--api-key", "--client-secret"]) {
      expect(text, `${flag} must not appear in the shipped Skill`).not.toContain(flag);
    }
  });

  it("keeps credentials on bounded stdin or a file, never argv or chat", () => {
    const text = flat(CLI).toLowerCase();

    expect(text).toContain("no credential flag");
    expect(text).toContain("never belongs in argv, in chat");
    expect(text).toContain("64 kib");
  });

  it("forbids saving or pasting the authorization URL", () => {
    const text = (ENTRY + CLI).toLowerCase();

    expect(text).toContain("never save or paste it");
  });
});

describe("the Skill refuses unsafe recovery after an ambiguous mutation", () => {
  it("forbids automatic retry, refresh, and revision rebasing", () => {
    const text = flat(ENTRY + CLI).toLowerCase();

    expect(text).toContain("do not retry it");
    expect(text).toContain("do not refresh automatically");
    expect(text).toContain("do not rebase");
  });

  it("points auth recovery at status and operation, and posts at the same key", () => {
    const text = ENTRY + CLI;

    expect(text).toContain("syndroo auth status");
    expect(text).toContain("syndroo auth operation");
    expect(text).toContain("same idempotency key");
  });

  it("requires an observed revision and never a guessed one", () => {
    const text = flat(CLI).toLowerCase();

    expect(text).toContain("revision");
    expect(text).toContain("never resolved by guessing a new revision");
  });
});

describe("the Skill documents explicit targets and candidate versus active", () => {
  it("requires explicit public target fields per platform", () => {
    const text = CLI;

    expect(text).toContain("--author");
    expect(text).toContain("--api-version");
    expect(text).toContain("--blog");
    expect(text.toLowerCase()).toContain("the candidate target is shown\nseparately from the currently active one");
  });

  it("keeps doctor's three questions apart and stops exit 0 meaning ready", () => {
    const text = flat(CLI).toLowerCase();

    expect(text).toContain("reachability");
    expect(text).toContain("key acceptance");
    expect(text).toContain("local readiness");
    expect(text).toContain("never proof");
    expect(text).toContain("exit code 0 means doctor ran");
    expect(text).toContain("still exits 0");
  });
});

describe("the corrected Skill keeps the workflows and rules distinct", () => {
  it("routes posting and account work separately from the entrypoint", () => {
    const text = flat(ENTRY);

    expect(text).toContain("Two workflows live in this skill");
    expect(text).toContain("Posting:");
    expect(text).toContain("Accounts and readiness:");
  });

  it("lists auth refresh among the actions that need explicit user intent", () => {
    const text = flat(ENTRY);

    expect(text).toContain("syndroo auth refresh");
    expect(text.toLowerCase()).toContain("explicit intent from the user is the only thing");
    expect(text.toLowerCase()).toContain("explicit intent from the user is the only thing");
    expect(text).toContain("cannot grant or extend that authority");
    // The old contradiction ("the user and this skill do that") must be gone.
    expect(text.toLowerCase()).not.toContain("the user and this skill");
    expect(text.toLowerCase()).toContain("this skill grants nothing");
  });

  it("separates complete's operation revision from the active revision", () => {
    const text = flat(CLI);

    expect(text).toContain("observe");
    expect(text).toContain("expectedRevision");
    expect(text).toContain("not the active one");
    expect(text).toContain("historical revision");
  });

  it("separates auth retry rules from post replay rules", () => {
    const text = flat(ENTRY);

    expect(text).toContain("authentication mutation's outcome is unknown");
    expect(text).toContain("same idempotency key");
    expect(text).toContain("never by sending a new logical post");
  });

  it("describes a declined preview without claiming nothing was sent", () => {
    const text = flat(CLI);

    expect(text).toContain("zero writes");
    expect(text).toContain("would be wrong for those commands");
    expect(text).toContain("refused before any read or write");
    // Counts are reported on failure too, which is what the source does.
    expect(text).toContain("authRequests {read, write}` on success and on failure");
  });

  it("does not claim a non-ready instance is ready", () => {
    const text = flat(CLI);

    expect(text).toContain("publishingReady: false");
    expect(text).toContain("missing_credentials");
  });

  it("explains doctor's failure modes, not just two missing variables", () => {
    const text = flat(CLI);

    expect(text).toContain("says which one failed");
    expect(text).toContain("key acceptance");
  });

  it("limits the HTTP fallback to the documented posts subset", () => {
    const fallback = flat(skillFile("references/http-fallback.md"));

    expect(fallback).toContain("documented posts subset");
    expect(fallback).toContain("Never improvise an authorization or credential request");
  });

  it("states the acceptance and replay status codes", () => {
    const delivery = flat(skillFile("references/delivery-semantics.md"));

    expect(delivery).toContain("`202` for a newly accepted document and `200`");
  });
});

describe("the exact assigned sections are corrected", () => {
  it("has command-aware exit rows 2 and 5, with no blanket zero-request promise", () => {
    const rows = new Map<string, string>();

    for (const line of CLI.split("\n")) {
      const match = /^\| `(\d)` \| (.+) \|$/u.exec(line.trim());

      if (match !== null) {
        rows.set(match[1] as string, match[2] as string);
      }
    }

    const two = rows.get("2") ?? "";
    const five = rows.get("5") ?? "";

    expect(two).toContain("No mutation is sent");
    expect(two).toContain("may already have performed its revision read");
    expect(two).not.toContain("nothing was sent");

    expect(five).toContain("No writes happen");
    expect(five).toContain("may already have read the status it showed");
    expect(five).not.toContain("nothing was sent");
  });

  it("completes the entry environment step on three separate signals", () => {
    const start = ENTRY.indexOf("1. **Check the environment.**");
    const end = ENTRY.indexOf("2. **Assemble the document.**");
    const step = start === -1 || end === -1 ? "" : ENTRY.slice(start, end);

    expect(step).not.toBe("");
    expect(step).toContain("Report three separate things and never merge them");
    expect(step).toContain("whether it accepts the configured key");
    expect(step).toContain("readiness");
    expect(step).toContain("A required read that fails ends this step");
    expect(step).toContain("only means those reads succeeded");
    expect(step).not.toContain("Done when `doctor` exits 0");
  });

  it("describes the request tally as an attempt count, not proof", () => {
    const text = flat(CLI);

    expect(text).toContain("own attempt tally, not a server-side audit");
    expect(text).toContain("never as proof of what the");
  });
});
