import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ROOT } from "./lib/v1-stages.ts";
import {
  DISPATCH_EVENT,
  DISPATCH_URL,
  TOKEN_ENV,
  VERSION_ENV,
  buildDispatchPayload,
  notifyFromEnvironment,
  notifyWebsiteRelease,
  parseFullSha,
  parseStableVersion,
  readCheckedOutHead,
  type FetchLike,
} from "./notify-website-release.ts";

const STABLE_VERSION = "0.8.0";
const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN_CANARY = "website-dispatch-token-canary";
const RESPONSE_BODY_CANARY = "response-body-credential-canary";
const RELEASE_WORKFLOW = join(ROOT, ".github/workflows/release.yml");

type CapturedRequest = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

function captureFetch(
  response: Response,
  requests: CapturedRequest[],
): FetchLike {
  return async (input, init) => {
    requests.push({ url: String(input), init });
    return response;
  };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  assert.ok(init !== undefined);
  return init.headers as Record<string, string>;
}

async function workflowSource(): Promise<string> {
  return readFile(RELEASE_WORKFLOW, "utf8");
}

/**
 * The named step and everything up to the next step. Every step in
 * `release.yml` starts at six-space indentation, so the next `      - name:`
 * marker is the boundary.
 */
function stepBlock(workflow: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow step ${name} is missing`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n      - name: /u);
  return next === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + next);
}

describe("website release notification payload", () => {
  it("accepts only stable semantic versions", () => {
    assert.equal(parseStableVersion(STABLE_VERSION), STABLE_VERSION);

    for (const version of [
      "",
      "0.8",
      "v0.8.0",
      "0.8.0-rc.1",
      "0.8.0+build.1",
      "01.8.0",
      "0.08.0",
      "0.8.0\n",
    ]) {
      assert.throws(
        () => parseStableVersion(version),
        /stable semver/u,
        `expected ${JSON.stringify(version)} to be rejected`,
      );
    }
  });

  it("accepts only full lowercase 40-character SHAs", () => {
    assert.equal(parseFullSha(FULL_SHA), FULL_SHA);

    for (const sha of [
      "",
      "0123456789abcdef",
      "0123456789ABCDEF0123456789ABCDEF01234567",
      "0123456789abcdef0123456789abcdef0123456g",
      `${FULL_SHA}0`,
      "0123456789abcdef0123456789abcdef0123456",
      `${FULL_SHA}\n`,
    ]) {
      assert.throws(
        () => parseFullSha(sha),
        /full lowercase 40-character commit SHA/u,
        `expected ${JSON.stringify(sha)} to be rejected`,
      );
    }
  });

  it("builds the exact event name and tag payload", () => {
    assert.deepEqual(buildDispatchPayload(STABLE_VERSION, FULL_SHA), {
      event_type: DISPATCH_EVENT,
      client_payload: {
        tag: `v${STABLE_VERSION}`,
        sha: FULL_SHA,
      },
    });
  });
});

describe("website release dispatch", () => {
  it("posts the exact JSON body to the fixed GitHub endpoint", async () => {
    const requests: CapturedRequest[] = [];
    const fetchImpl = captureFetch(new Response(null, { status: 204 }), requests);

    await notifyWebsiteRelease({
      token: TOKEN_CANARY,
      version: STABLE_VERSION,
      sha: FULL_SHA,
      fetchImpl,
    });

    assert.equal(requests.length, 1, "exactly one POST, never a retry");
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.url, DISPATCH_URL);
    assert.equal(request.url, "https://api.github.com/repos/Syndroo/syndroo-web/dispatches");
    assert.equal(request.init?.method, "POST");
    assert.equal(request.init?.redirect, "error", "redirects must be refused");
    assert.ok(
      request.init?.signal instanceof AbortSignal,
      "the request must carry an abort timeout signal",
    );
    assert.equal(request.init.signal.aborted, false);

    const headers = headersOf(request.init);
    assert.equal(headers["authorization"], `Bearer ${TOKEN_CANARY}`);
    assert.equal(headers["accept"], "application/vnd.github+json");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["x-github-api-version"], "2022-11-28");

    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      event_type: "syndroo-release",
      client_payload: {
        tag: "v0.8.0",
        sha: FULL_SHA,
      },
    });
  });

  it("fails on every non-204 response without retrying or logging the body", async () => {
    for (const status of [200, 201, 403, 500]) {
      const requests: CapturedRequest[] = [];
      const fetchImpl = captureFetch(
        new Response(RESPONSE_BODY_CANARY, { status }),
        requests,
      );

      await assert.rejects(
        notifyWebsiteRelease({
          token: TOKEN_CANARY,
          version: STABLE_VERSION,
          sha: FULL_SHA,
          fetchImpl,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(`HTTP ${String(status)}`, "u"));
          assert.equal(error.message.includes(TOKEN_CANARY), false);
          assert.equal(error.message.includes(RESPONSE_BODY_CANARY), false);
          return true;
        },
      );

      assert.equal(requests.length, 1, `${String(status)} must not be retried`);
    }
  });

  it("fails generically on a network timeout without retrying or leaking the token", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new DOMException(
        `simulated timeout ${TOKEN_CANARY}`,
        "TimeoutError",
      );
    };

    await assert.rejects(
      notifyWebsiteRelease({
        token: TOKEN_CANARY,
        version: STABLE_VERSION,
        sha: FULL_SHA,
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /failed or timed out before a response was received/u,
        );
        assert.equal(error.message.includes(TOKEN_CANARY), false);
        assert.equal(error.message.includes("simulated timeout"), false);
        return true;
      },
    );

    assert.equal(calls, 1, "a timed-out POST must not be retried");
  });

  it("fails clearly before fetching when the token is missing", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };

    await assert.rejects(
      notifyFromEnvironment(
        { [VERSION_ENV]: STABLE_VERSION },
        { headSha: FULL_SHA, fetchImpl },
      ),
      new RegExp(TOKEN_ENV, "u"),
    );
    assert.equal(calls, 0, "a missing token must not produce a request");

    await assert.rejects(
      notifyWebsiteRelease({
        token: "",
        version: STABLE_VERSION,
        sha: FULL_SHA,
        fetchImpl,
      }),
      new RegExp(TOKEN_ENV, "u"),
    );
    assert.equal(calls, 0);
  });

  it("resolves the checked-out HEAD without exposing the token to git", async () => {
    const directory = await mkdtemp(join(tmpdir(), "syndroo-website-release-"));
    try {
      const fakeGit = join(directory, "git");
      const fakeSha = "b".repeat(40);
      await writeFile(
        fakeGit,
        [
          "#!/bin/sh",
          `if [ -n "\${${TOKEN_ENV}:-}" ]; then`,
          '  echo "dispatch token leaked to the git child process" >&2',
          "  exit 3",
          "fi",
          `printf '%s\\n' '${fakeSha}'`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const sha = readCheckedOutHead({
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          [TOKEN_ENV]: TOKEN_CANARY,
        },
      });

      assert.equal(sha, fakeSha);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("release workflow website gate", () => {
  it("marks the publish step and gates notification on enabled, successful, stable", async () => {
    const workflow = await workflowSource();
    const publish = stepBlock(workflow, "Publish the train");
    const notification = stepBlock(
      workflow,
      "Notify the website of the stable release",
    );

    assert.match(publish, /^\s+id: publish$/mu);
    assert.ok(
      workflow.indexOf("Notify the website of the stable release") >
        workflow.indexOf("Publish the train"),
      "notification must run after the publish train",
    );

    assert.match(notification, /vars\.SYNDROO_SYNC_WEBSITE == 'true'/u);
    assert.match(notification, /steps\.publish\.outcome == 'success'/u);
    assert.match(notification, /steps\.train\.outputs\.dist_tag == 'latest'/u);
    assert.match(
      notification,
      /SYNDROO_RELEASE_VERSION: \$\{\{ steps\.train\.outputs\.version \}\}/u,
    );

    const run = notification.match(/^\s+run: (.+)$/mu);
    assert.equal(run?.[1], "node scripts/notify-website-release.ts");
    assert.doesNotMatch(String(run?.[1]), /\$\{\{/u);

    // A validate-only run, a failed publish, or a prerelease (`next`)
    // dist-tag cannot satisfy all three conditions.
    assert.doesNotMatch(notification, /continue-on-error/u);
  });

  it("passes the dispatch secret only to the notification step", async () => {
    const workflow = await workflowSource();
    const notification = stepBlock(
      workflow,
      "Notify the website of the stable release",
    );
    const beforeNotification = workflow.slice(
      0,
      workflow.indexOf("Notify the website of the stable release"),
    );

    assert.equal(
      workflow.split("secrets.SYNDROO_WEB_DISPATCH_TOKEN").length - 1,
      1,
      "the website token must appear exactly once",
    );
    assert.match(notification, /secrets\.SYNDROO_WEB_DISPATCH_TOKEN/u);
    assert.doesNotMatch(beforeNotification, /SYNDROO_WEB_DISPATCH_TOKEN/u);
    assert.doesNotMatch(workflow, /SYNDROO_SYNC_WEBSITE: /u);
  });
});
