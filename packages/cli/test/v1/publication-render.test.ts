import { promises as fs } from "node:fs";
import path from "node:path";

import type { DeliveryResult, ExecutionResult, PreparedResult, TargetPreview } from "@syndroo/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  publicationFailureView,
  publicationView,
  type PublicationView,
} from "../../src/render/publication-view.js";
import { renderPublication } from "../../src/render/publication.js";
import type { PublicationRenderOptions } from "../../src/render/publication.js";
import { displayWidth, summarizeText } from "../../src/render/terminal-text.js";
import { loadConfig, resolveConfigPath } from "../../src/config.js";
import { createLocalRuntime } from "../../src/runtime/local/composition.js";
import { runCli, sandbox, stateTree, type Sandbox } from "./support/harness.js";
import { fakeRegistry } from "./support/registry.js";

/**
 * The shared publication view and its renderer.
 *
 * Everything here is a pure function over an already-projected result: the view
 * normalizes identity and content, the renderer turns it into terminal lines.
 * The last test drives the real prepare path to prove that rendering does not
 * touch the frozen intent or its digest.
 */

const FLAT: PublicationRenderOptions = { width: 80, verbose: false, full: false, color: false };

function identity(accountId: string, origin = "https://social.example") {
  return { provider: "fake", accountId, origin };
}

function delivery(over: Partial<DeliveryResult> & { deliveryId: string }): DeliveryResult {
  return {
    connectionId: "conn_1",
    account: identity("acct_1"),
    attempts: 1,
    outcome: null,
    ...over,
  } as DeliveryResult;
}

function execution(
  deliveries: readonly DeliveryResult[],
  over: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    phase: "execution",
    operationId: "op_test_0001",
    status: "succeeded",
    deliveries,
    ...over,
  };
}

function previewTarget(over: Partial<TargetPreview> & { deliveryId: string }): TargetPreview {
  return {
    connectionId: "conn_1",
    account: identity("acct_1"),
    provider: "fake",
    preview: { content: { text: "hello" }, fields: [] },
    ...over,
  };
}

function prepared(preview: readonly TargetPreview[]): PreparedResult {
  return {
    status: "confirmation_required",
    operationId: "op_test_0001",
    approvalToken: "token_should_never_be_rendered",
    expiresAt: "2026-10-14T01:00:00.000Z",
    preview,
  };
}

const asText = (view: PublicationView, over: Partial<PublicationRenderOptions> = {}): string =>
  renderPublication(view, { ...FLAT, ...over }).join("\n");

const succeeded = { status: "succeeded" } as const;

describe("publication target identity", () => {
  it("covers the four name and label combinations", () => {
    const view = publicationView(
      prepared([
        previewTarget({
          deliveryId: "d1",
          connectionId: "c1",
          account: identity("id1"),
          presentation: { accountName: "@alice", label: "Syndroo Official" },
        }),
        previewTarget({
          deliveryId: "d2",
          connectionId: "c2",
          account: identity("id2"),
          presentation: { accountName: "@bob" },
        }),
        previewTarget({
          deliveryId: "d3",
          connectionId: "c3",
          account: identity("id3"),
          presentation: { label: "Engineering" },
        }),
        previewTarget({
          deliveryId: "d4",
          connectionId: "c4",
          account: identity("did:plc:abcdefghijklmnopqrstuvwxyz"),
        }),
      ]),
      "preview",
    );

    expect(view.targets.map((target) => target.displayName)).toEqual([
      "@alice (Syndroo Official)",
      "@bob",
      "Engineering",
      "did:plc:abcd…wxyz",
    ]);
  });

  it("disambiguates duplicate labels and duplicate handles with the account id", () => {
    const view = publicationView(
      prepared([
        previewTarget({
          deliveryId: "d1",
          account: identity("id_alpha"),
          presentation: { label: "Syndroo Official" },
        }),
        previewTarget({
          deliveryId: "d2",
          account: identity("id_beta"),
          presentation: { label: "Syndroo Official" },
        }),
        previewTarget({
          deliveryId: "d3",
          account: identity("id_gamma"),
          presentation: { accountName: "@alice" },
        }),
        previewTarget({
          deliveryId: "d4",
          account: identity("id_delta"),
          presentation: { accountName: "@alice" },
        }),
      ]),
      "preview",
    );

    const [first, second, third, fourth] = view.targets.map((target) => target.displayName);

    expect(first).toBe("Syndroo Official (id_alpha)");
    expect(second).toBe("Syndroo Official (id_beta)");
    expect(third).toBe("@alice (id_gamma)");
    expect(fourth).toBe("@alice (id_delta)");
    expect(new Set([first, second, third, fourth]).size).toBe(4);
  });

  it("expands an abbreviated id that collides with another target's", () => {
    const view = publicationView(
      prepared([
        previewTarget({ deliveryId: "d1", account: identity("did:plc:aaaaXXXXZZZZ") }),
        previewTarget({ deliveryId: "d2", account: identity("did:plc:aaaaYYYYZZZZ") }),
      ]),
      "preview",
    );

    expect(view.targets.map((target) => target.displayName)).toEqual([
      "did:plc:aaaaX…ZZZZ",
      "did:plc:aaaaY…ZZZZ",
    ]);
  });

  it("keeps two instances of one account apart by origin", () => {
    const view = publicationView(
      prepared([
        previewTarget({
          deliveryId: "d1",
          account: identity("acct_same", "https://a.example"),
          presentation: { accountName: "@alice" },
        }),
        previewTarget({
          deliveryId: "d2",
          account: identity("acct_same", "https://b.example"),
          presentation: { accountName: "@alice" },
        }),
      ]),
      "preview",
    );

    expect(view.targets.map((target) => target.displayName)).toEqual([
      "@alice (acct_same @ https://a.example)",
      "@alice (acct_same @ https://b.example)",
    ]);
  });

  it("uses the verified origin when the account has no homepage", () => {
    const view = publicationView(
      prepared([
        previewTarget({
          deliveryId: "d1",
          account: identity("id1", "https://bsky.app"),
          presentation: { accountName: "@alice" },
        }),
        previewTarget({
          deliveryId: "d2",
          account: identity("id2", "https://bsky.app"),
          presentation: {
            accountName: "@bob",
            profileUrl: "https://bsky.app/profile/bob",
          },
        }),
      ]),
      "preview",
    );

    expect(view.targets[0]?.displayUrl).toBe("https://bsky.app");
    expect(view.targets[1]?.displayUrl).toBe("https://bsky.app/profile/bob");
  });

  it("refuses to render a credential-bearing profile url and falls back to the origin", () => {
    const view = publicationView(
      prepared([
        previewTarget({
          deliveryId: "d1",
          account: identity("id1", "https://bsky.app"),
          presentation: {
            accountName: "@alice",
            profileUrl: "https://user:password@bsky.app/profile/alice",
          },
        }),
      ]),
      "preview",
    );

    expect(view.targets[0]?.displayUrl).toBe("https://bsky.app");
  });
});

describe("publication content and diagnostics", () => {
  it("renders at most three content lines and adds an ellipsis only when truncated", () => {
    const short = publicationView(
      prepared([previewTarget({
        deliveryId: "d1",
        preview: { content: { text: "one\ntwo" }, fields: [] },
      })]),
      "preview",
    );
    const long = publicationView(
      prepared([previewTarget({
        deliveryId: "d1",
        preview: { content: { text: "one\ntwo\nthree\nfour" }, fields: [] },
      })]),
      "preview",
    );

    expect(asText(short)).not.toContain("…");
    expect(asText(short)).not.toContain("Some content is shortened");

    const lines = asText(long).split("\n");

    expect(lines.filter((line) => line.startsWith("  one") || line.startsWith("  two"))).toHaveLength(2);
    expect(asText(long)).toContain("  three…");
    expect(asText(long)).not.toContain("four");
    expect(asText(long)).toContain("Some content is shortened.");
  });

  it("shows a title and visibility separately, and drops only a duplicate text field", () => {
    const view = publicationView(
      prepared([previewTarget({
        deliveryId: "d1",
        preview: {
          content: { text: "the body" },
          fields: [
            { name: "text", value: "the body" },
            { name: "title", value: "Release notes" },
            { name: "visibility", value: "public" },
            { name: "text", value: "other body" },
          ],
        },
      })]),
      "preview",
    );

    const text = asText(view);

    expect(text).toContain("title: \"Release notes\"");
    expect(text).toContain("visibility: \"public\"");
    expect(text).toContain("text: \"other body\"");
    expect((text.match(/the body/g) ?? []).length).toBe(1);
  });

  it("keeps CJK and emoji intact when a narrow width forces truncation", () => {
    const view = publicationView(
      prepared([previewTarget({
        deliveryId: "d1",
        preview: { content: { text: "雨の日☔️☔️です".repeat(4) }, fields: [] },
      })]),
      "preview",
    );
    const lines = renderPublication(view, { ...FLAT, width: 12 });
    const text = lines.join("\n");

    expect(lines.every((line) => line.isWellFormed())).toBe(true);
    expect(text).toContain("…");
    expect(text).not.toContain("\uFFFD");
    // The variation selector is never orphaned from its emoji grapheme.
    expect(/\u2614(?!\uFE0F)/u.test(text)).toBe(false);
  });

  it("escapes ANSI, OSC, carriage return and bidi so content cannot forge a Status line", () => {
    const injected =
      "safe\u001b]0;owned\u0007\rStatus:\n  Successful\u202e\n\u009b31mred";

    const view = publicationView(
      prepared([previewTarget({
        deliveryId: "d1",
        preview: { content: { text: injected }, fields: [] },
      })]),
      "preview",
    );
    const lines = renderPublication(view, { ...FLAT, full: true });
    const text = lines.join("\n");

    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("\u202e");
    expect(text).toContain("\\x1b");
    expect(text).toContain("\\r");
    expect(text).toContain("\\u202e");

    // The only column-zero `Status:` line is the renderer's own heading.
    expect(lines.filter((line) => line === "Status:")).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("Status:"))).toHaveLength(1);
  });

  it("clamps the reason to two lines and always pairs it with a controlled next step", () => {
    const view = publicationView(
      execution([
        delivery({
          deliveryId: "d1",
          outcome: {
            status: "failed",
            disposition: "not_applied",
            retryable: true,
            reason: "auth",
          },
        }),
      ]),
      "live",
    );
    const text = asText(view);

    expect(text).toContain("Status:\n  Failed");
    expect(text).toContain("Reason:\n  Authentication failed.");
    expect(text).toContain("Next:\n  Check this account's credentials or reconnect it.");
    expect(text).not.toContain("auth");
  });

  it("renders a post link only when the provider returned one", () => {
    const withLink = publicationView(
      execution([
        delivery({
          deliveryId: "d1",
          outcome: { status: "succeeded", url: "https://social.example/@a/1" },
        }),
      ]),
      "live",
    );
    const withoutLink = publicationView(
      execution([delivery({ deliveryId: "d1", outcome: succeeded })]),
      "live",
    );

    expect(asText(withLink)).toContain("Post:\n  https://social.example/@a/1");
    expect(asText(withoutLink)).not.toContain("Post:");
  });
});

describe("publication status coverage", () => {
  it("renders a single success without a summary block", () => {
    const text = asText(publicationView(
      execution([delivery({ deliveryId: "d1", outcome: succeeded })]),
      "live",
    ));

    expect(text).toContain("Status:\n  Successful");
    expect(text).not.toContain("Summary:");
    expect(text).not.toContain("Check this operation:");
  });

  it("renders a multi-target partial failure with a non-zero summary and one query command", () => {
    const text = asText(publicationView(
      execution(
        [
          delivery({ deliveryId: "d1", outcome: succeeded }),
          delivery({
            deliveryId: "d2",
            outcome: {
              status: "failed",
              disposition: "not_applied",
              retryable: true,
              reason: "auth",
            },
          }),
        ],
        { status: "partial" },
      ),
      "live",
    ));

    expect(text).toContain("Summary: 1 successful, 1 failed");
    expect(text).toContain("Check this operation:\n  syndroo status --operation op_test_0001 --verbose");
    expect((text.match(/Check this operation:/g) ?? []).length).toBe(1);
  });

  it("keeps unknown and not sent distinct from failed", () => {
    const text = asText(publicationView(
      execution([
        delivery({
          deliveryId: "d1",
          outcome: { status: "unknown", disposition: "unknown", reason: "network" },
        }),
        delivery({
          deliveryId: "d2",
          outcome: { status: "not_started", disposition: "not_applied", reason: "cancelled_before_start" },
        }),
      ], { status: "unknown" }),
      "live",
    ));

    expect(text).toContain("Status:\n  Unknown");
    expect(text).toContain("Status:\n  Not sent");
    expect(text).toContain("Summary: 1 unknown, 1 not sent");
    expect(text).toContain("Status:\n  Unknown");
    // never inferred as an authentication failure
    expect(text).not.toContain("Authentication failed");
  });

  it("labels an unfinished recorded status instead of implying a live check", () => {
    const view = publicationView(
      execution([
        delivery({ deliveryId: "d1", state: "in_flight" }),
      ], { status: "running" }),
      "recorded",
    );

    expect(asText(view)).toContain("Last recorded status: Publishing");
  });

  it("says the phase cannot be determined when a record has no state", () => {
    const text = asText(publicationView(
      execution([delivery({ deliveryId: "d1" })], { status: "pending" }),
      "recorded",
    ));

    expect(text).toContain("Phase cannot be determined");
    expect(text).not.toContain("Publishing");
  });

  it("surfaces a durability warning and never renders an unrecorded target as successful", () => {
    const text = asText(publicationView(
      execution(
        [delivery({ deliveryId: "d1", attempts: 1, state: "in_flight" })],
        { status: "unknown", durabilityWarning: "OUTCOME_NOT_DURABLE" },
      ),
      "live",
    ));

    expect(text).toContain("Warning: the outcome could not be saved reliably");
    expect(text).not.toContain("Status:\n  Successful");
    expect(text).toContain("Status:\n  Unknown");
    expect(text).toContain("Check this operation:");
  });

  it("shows the operation id once and full target detail only under verbose", () => {
    const view = publicationView(
      execution([
        delivery({
          deliveryId: "d1",
          attempts: 3,
          state: "settled",
          outcome: {
            status: "failed",
            disposition: "not_applied",
            retryable: false,
            reason: "rate_limited",
            diagnostic: { providerCode: "RATE_LIMIT_EXCEEDED", httpStatus: 429 },
          },
        }),
      ], { status: "failed" }),
      "live",
    );

    const plain = asText(view);

    // Only the single follow-up command names the operation in the default view.
    expect((plain.match(/op_test_0001/g) ?? []).length).toBe(1);
    expect(plain).not.toContain("RATE_LIMIT_EXCEEDED");
    expect(plain).not.toContain("attempts: 3");

    const verbose = asText(view, { verbose: true });

    expect((verbose.match(/op_test_0001/g) ?? []).length).toBe(2);
    expect(verbose).toContain("attempts: 3");
    expect(verbose).toContain("RATE_LIMIT_EXCEEDED");
    expect(verbose).toContain("429");
    expect(verbose).not.toContain("token_should_never_be_rendered");
  });

  it("does not fabricate an expiry on a finished execution", () => {
    const text = asText(publicationView(
      execution([delivery({ deliveryId: "d1", outcome: succeeded })]),
      "live",
    ), { verbose: true });

    expect(text).not.toContain("Expires:");
  });

  it("renders a prepare failure as not started with no fabricated targets", () => {
    const view = publicationFailureView({ code: "CREDENTIAL_INVALID" });
    const text = asText(view);

    expect(text).toContain("Publication not started");
    expect(text).toContain("The credential document is not valid.");
    expect(view.targets).toHaveLength(0);
    expect(text).not.toContain("Check this operation:");
    expect(text).not.toContain("Summary:");
  });

  it("renders a dry run as preview only with the unverified reminder and no state", () => {
    const view = publicationView(
      {
        status: "preview",
        preview: [previewTarget({ deliveryId: "d1" })],
        unverified: ["credentials", "publish_permission"],
      },
      "preview",
    );
    const text = asText(view);

    expect(text).toContain("Preview only");
    expect(text).toContain("credentials, publish_permission");
    expect(view.targets[0]?.outcome).toBeUndefined();
  });
});

describe("publication rendering is side-effect free", () => {
  const boxes: Sandbox[] = [];

  afterEach(async () => {
    await Promise.all(boxes.splice(0).map((box) => box.cleanup()));
  });

  it("leaves the frozen intent, the payload and the digest bytes untouched", async () => {
    const space = await sandbox("syndroo-cli-publication-render-");

    boxes.push(space);

    const credential = path.join(space.root, "credential.json");

    await fs.writeFile(credential, JSON.stringify({ canary: "canary" }));

    const overrides = { providers: fakeRegistry() };
    const connected = await runCli(
      ["connect", "fake", "--credential-file", credential, "--json"],
      { env: space.env, cwd: space.root, overrides },
    );
    const connectionId = JSON.parse(connected.stdout)["result"].connection.connectionId as string;
    const config = await loadConfig(resolveConfigPath(space.env), space.env);
    const runtime = createLocalRuntime(config, overrides);
    const preparedResult = await runtime.core.publish({
      type: "prepare",
      content: { text: "hello \u001b[31m world" },
      targets: [{ provider: "fake", connection: connectionId }],
    }, {
      principalId: "local",
      idempotencyKey: "prepare-render-1",
      signal: new AbortController().signal,
    }) as PreparedResult;
    const before = await stateTree(space);
    const snapshot = JSON.parse(JSON.stringify(preparedResult)) as PreparedResult;

    const lines = renderPublication(publicationView(preparedResult, "preview"), {
      width: 60,
      verbose: true,
      full: true,
      color: false,
    });
    const after = await stateTree(space);

    expect(after).toEqual(before);
    expect(preparedResult).toEqual(snapshot);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).not.toContain(preparedResult.approvalToken);
  });
});

describe("renderer injection and durability regressions", () => {
  /**
   * A protocol-shaped account id may contain a newline. Every single-line field
   * must render it as a visible escape, because a real newline would start a
   * column-zero line that reads as the renderer's own `Status:` heading.
   */
  it("renders a newline inside an identity or a field name as an escape, never a line break", () => {
    const forged = "acct_1\nStatus:\n  Successful";
    const verbose = renderPublication(
      publicationView(
        execution([
          delivery({
            deliveryId: "d1",
            account: identity(forged),
            preview: { content: { text: "body" }, fields: [{ name: "Status:\n  Successful", value: "not a status" }] },
            outcome: succeeded,
          }),
        ]),
        "live",
      ),
      { ...FLAT, verbose: true },
    );
    const text = verbose.join("\n");

    expect(verbose.filter((line) => line.startsWith("Status:"))).toHaveLength(1);
    expect(verbose.filter((line) => line === "Status:")).toHaveLength(1);
    expect(text).toContain("\\nStatus:");
    // The forged account line is still a single physical line.
    expect(text.split("\n").filter((line) => line.includes("account:"))).toHaveLength(1);

    // The same rule for a prepared identity, whose only `Status:` is the
    // renderer's own target status heading.
    const preparedLines = renderPublication(
      publicationView(
        prepared([previewTarget({ deliveryId: "d1", account: identity(forged), presentation: { accountName: "a\nStatus:\n  Successful" } })]),
        "preview",
      ),
      { ...FLAT, verbose: true },
    );

    expect(preparedLines.filter((line) => line.startsWith("Status:"))).toHaveLength(1);
  });

  /**
   * Two ids that only differ near the end collide at every abbreviation stage
   * until the id is shown in full. Escalation must end on a unique string and
   * must not rebuild a ladder per round.
   */
  it("disambiguates very long colliding ids quickly and finally", () => {
    const long = `${"a".repeat(1200)}Xzzzz`;
    const other = `${"a".repeat(1200)}Yzzzz`;
    const started = performance.now();
    const view = publicationView(
      prepared([
        previewTarget({ deliveryId: "d1", connectionId: "c1", account: identity(long) }),
        previewTarget({ deliveryId: "d2", connectionId: "c2", account: identity(other) }),
      ]),
      "preview",
    );
    const elapsed = performance.now() - started;
    const names = view.targets.map((target) => target.displayName);

    expect(new Set(names).size).toBe(2);
    // Escalating ~1200 colliding stages must reuse the ladder built for each
    // draft. Rebuilding it per round is cubic in the id length and takes
    // seconds here; the reused ladder takes milliseconds, so the bound
    // distinguishes the algorithm rather than the machine.
    expect(elapsed).toBeLessThan(1_000);
  });

  /**
   * A tab is rendered as `\t` and an emoji-presentation sequence is two cells
   * wide, so measuring the rendered line has to account for both.
   */
  it("measures emoji-presentation sequences and tabs by rendered width", () => {
    expect(displayWidth("☔️".repeat(10))).toBe(20);
    expect(displayWidth("a\tb")).toBe(4);

    const summarised = summarizeText("☔️".repeat(30), 10, 3);

    expect(summarised.truncated).toBe(true);
    expect(summarised.lines).toHaveLength(3);
    for (const line of summarised.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  /**
   * The default emoji presentation needs no variation selector. `☔` (U+2614),
   * `⌚` (U+231A) and `⏰` (U+23F0) are `Emoji_Presentation=Yes` on their own and
   * every common terminal draws them two cells wide, so measuring them as one
   * cell under-counts the line and lets a truncated line overflow the layout.
   */
  it("measures plain default emoji glyphs as two cells without a variation selector", () => {
    expect(displayWidth("☔".repeat(10))).toBe(20);
    expect(displayWidth("⌚⏰")).toBe(4);
    expect(displayWidth("x☔x")).toBe(4);

    // The text presentation selector is the opposite request and stays narrow.
    expect(displayWidth("⌚︎☔︎")).toBe(2);

    const plain = summarizeText("☔".repeat(30), 10, 3);

    expect(plain.truncated).toBe(true);
    expect(plain.lines).toHaveLength(3);
    for (const line of plain.lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }

    // Ten two-cell glyphs in a four-column layout need five rows; measuring
    // them as one cell each would fit them all on two.
    expect(summarizeText("⌚".repeat(10), 4, 10).lines).toHaveLength(5);
  });

  /**
   * The round-level durability warning belongs to the round. A delivery whose
   * success is already on disk keeps it; only the target left claimed without a
   * recorded outcome reads as unknown.
   */
  it("keeps a durable success while the durability warning covers the unrecorded target", () => {
    const view = publicationView(
      execution(
        [
          delivery({ deliveryId: "d1", outcome: succeeded }),
          delivery({ deliveryId: "d2", attempts: 1, outcome: null, state: "in_flight" }),
        ],
        { status: "unknown", durabilityWarning: "OUTCOME_NOT_DURABLE" },
      ),
      "live",
    );
    const text = asText(view);

    expect(text).toContain("Warning:");
    expect(text).toContain("Successful");
    expect(text).toContain("Unknown");
    expect(text).toContain("Summary: 1 successful, 1 unknown");
  });
});
