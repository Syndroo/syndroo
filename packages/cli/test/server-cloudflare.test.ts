import { describe, expect, it } from "vitest";

import {
  createCloudflareApi,
  resolveCloudflareSession,
} from "../src/server/cloudflare.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../src/server/process.js";

class IdentityRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];

  constructor(
    private readonly accounts: readonly {
      readonly id: string;
      readonly name: string;
    }[],
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    if (request.args[0] === "whoami") {
      return {
        status: "exited",
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authType: "OAuth Token",
          accounts: this.accounts,
        }),
        stderr: "",
      };
    }
    return {
      status: "exited",
      exitCode: 0,
      stdout: JSON.stringify({
        type: "oauth",
        token: "access-token",
      }),
      stderr: "",
    };
  }
}

describe("Cloudflare deployment API client", () => {
  it("requires an unambiguous account", async () => {
    const runner = new IdentityRunner([
      { id: "one", name: "One" },
      { id: "two", name: "Two" },
    ]);

    await expect(
      resolveCloudflareSession(runner, "/tmp", {}, undefined),
    ).rejects.toMatchObject({
      code: "SERVER_DEPLOY_ACCOUNT_SELECTION_REQUIRED",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("does not expose captured authentication output in errors", async () => {
    const runner: ProcessRunner = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.args[0] === "whoami") {
          return {
            status: "exited",
            exitCode: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authType: "API Token",
              accounts: [{ id: "account-id", name: "Account" }],
            }),
            stderr: "",
          };
        }
        return {
          status: "exited",
          exitCode: 0,
          stdout: JSON.stringify({
            type: "api_key",
            key: "AUTH-OUTPUT-CANARY",
          }),
          stderr: "",
        };
      },
    };
    const error = await resolveCloudflareSession(
      runner,
      "/tmp",
      {},
      "account-id",
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SERVER_DEPLOY_CLOUDFLARE_AUTH_UNSUPPORTED",
    });
    expect(JSON.stringify(error)).not.toContain("AUTH-OUTPUT-CANARY");
  });

  it("uses the fixed origin, rejects redirects, and bounds response bodies", async () => {
    let observed: {
      url: string;
      init: RequestInit | undefined;
    } | undefined;
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      observed = { url: String(input), init };
      return new Response(
        JSON.stringify({
          success: true,
          result: { subdomain: "x".repeat(1_048_576) },
          errors: [],
        }),
      );
    };
    const api = createCloudflareApi({
      accountId: "account-id",
      token: "access-token",
      fetch: fetcher as typeof fetch,
    });

    await expect(api.workersDevSubdomain()).rejects.toMatchObject({
      code: "SERVER_DEPLOY_REMOTE_OUTPUT_LIMIT",
    });
    expect(observed?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/workers/subdomain",
    );
    expect(observed?.init?.redirect).toBe("error");
    expect(new Headers(observed?.init?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
  });
});
