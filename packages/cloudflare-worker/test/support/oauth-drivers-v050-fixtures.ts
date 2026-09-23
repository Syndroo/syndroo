/**
 * Fail-closed outbound fixture for the concrete OAuth driver tests.
 *
 * Every request the drivers make inside workerd passes through this handler.
 * Listed provider destinations get deterministic responses selected by a
 * scenario token taken from the request itself (the OAuth1 `state` inside the
 * signed callback, or the OAuth2 `code`/`refresh_token` form value); anything
 * else throws, so a test can never reach the internet.
 *
 * The recorded request log is exposed to the spec through control routes on
 * `https://stats.invalid`, which is how the native tests assert the actual
 * method, URL, headers, body and request counts.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface OAuthFixtureState {
  readonly requests: readonly RecordedRequest[];
  readonly unexpected: number;
}

interface FixtureResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

const FORM = "application/x-www-form-urlencoded";
const JSON_TYPE = "application/json";
const MAX_RECORDED = 32;

const X_REQUEST_OK: FixtureResponse = {
  status: 200,
  body: "oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true",
  contentType: FORM,
};
const X_ACCESS_OK: FixtureResponse = {
  status: 200,
  body: "oauth_token=acc-token&oauth_token_secret=acc-secret",
  contentType: FORM,
};
const TUMBLR_REQUEST_OK: FixtureResponse = {
  status: 200,
  body: "oauth_token=tumblr-req&oauth_token_secret=tumblr-req-secret&oauth_callback_confirmed=true",
  contentType: FORM,
};
const TUMBLR_ACCESS_OK: FixtureResponse = {
  status: 200,
  body: "oauth_token=tumblr-acc&oauth_token_secret=tumblr-acc-secret",
  contentType: FORM,
};
const LINKEDIN_TOKEN_OK: FixtureResponse = {
  status: 200,
  body: '{"access_token":"li-token","refresh_token":"li-refresh","expires_in":3600}',
  contentType: JSON_TYPE,
};

/** Scenario overrides, keyed by the operation and then by the scenario token. */
const SCENARIOS: Readonly<Record<string, Readonly<Record<string, FixtureResponse>>>> =
  Object.freeze({
    "x-request": {
      "state-duplicate": {
        status: 200,
        body: "oauth_token=a&oauth_token=b&oauth_token_secret=s&oauth_callback_confirmed=true",
        contentType: FORM,
      },
      "state-unconfirmed": {
        status: 200,
        body: "oauth_token=a&oauth_token_secret=s&oauth_callback_confirmed=false",
        contentType: FORM,
      },
      "state-missing-token": {
        status: 200,
        body: "oauth_token_secret=s&oauth_callback_confirmed=true",
        contentType: FORM,
      },
      "state-empty-secret": {
        status: 200,
        body: "oauth_token=a&oauth_token_secret=&oauth_callback_confirmed=true",
        contentType: FORM,
      },
      "state-not-form": { status: 200, body: "<html>denied</html>", contentType: "text/html" },
      "state-redirect": { status: 302, body: "", contentType: "text/plain" },
      "state-oversized": { status: 200, body: "a".repeat(70 * 1024), contentType: FORM },
      "state-denied": { status: 401, body: "denied", contentType: "text/plain" },
      "state-unavailable": { status: 503, body: "later", contentType: "text/plain" },
      "state-padded-secret": {
        status: 200,
        body: "oauth_token=req-token&oauth_token_secret=%20req-secret%20&oauth_callback_confirmed=true",
        contentType: FORM,
      },
      "state-control-token": {
        status: 200,
        body: "oauth_token=req%0Atoken&oauth_token_secret=req-secret&oauth_callback_confirmed=true",
        contentType: FORM,
      },
    },
    "x-access": {
      "verifier-duplicate": {
        status: 200,
        body: "oauth_token=a&oauth_token=b&oauth_token_secret=s",
        contentType: FORM,
      },
      "verifier-missing-secret": { status: 200, body: "oauth_token=a", contentType: FORM },
      "verifier-padded-token": {
        status: 200,
        body: "oauth_token=%20acc-token&oauth_token_secret=acc-secret",
        contentType: FORM,
      },
      "verifier-control-secret": {
        status: 200,
        body: "oauth_token=acc-token&oauth_token_secret=acc%00secret",
        contentType: FORM,
      },
    },
    "tumblr-request": {
      "state-unconfirmed": {
        status: 200,
        body: "oauth_token=a&oauth_token_secret=s&oauth_callback_confirmed=maybe",
        contentType: FORM,
      },
      "state-padded-token": {
        status: 200,
        body: "oauth_token=%20tumblr-req&oauth_token_secret=tumblr-req-secret&oauth_callback_confirmed=true",
        contentType: FORM,
      },
    },
    "tumblr-access": {
      "verifier-padded-secret": {
        status: 200,
        body: "oauth_token=tumblr-acc&oauth_token_secret=%20tumblr-acc-secret%20",
        contentType: FORM,
      },
    },
    "linkedin-token": {
      "code-bad-json": { status: 200, body: "not-json", contentType: JSON_TYPE },
      "code-array": { status: 200, body: '["token"]', contentType: JSON_TYPE },
      "code-empty-token": { status: 200, body: '{"access_token":""}', contentType: JSON_TYPE },
      "code-padded-token": {
        status: 200,
        body: '{"access_token":" li-token "}',
        contentType: JSON_TYPE,
      },
      "code-control-token": {
        status: 200,
        body: '{"access_token":"li\\u0000token"}',
        contentType: JSON_TYPE,
      },
      "code-padded-refresh": {
        status: 200,
        body: '{"access_token":"li-token","refresh_token":" li-refresh "}',
        contentType: JSON_TYPE,
      },
      "code-no-token": { status: 200, body: '{"refresh_token":"r"}', contentType: JSON_TYPE },
      "code-no-refresh": { status: 200, body: '{"access_token":"li-token"}', contentType: JSON_TYPE },
      "code-empty-refresh": {
        status: 200,
        body: '{"access_token":"li-token","refresh_token":""}',
        contentType: JSON_TYPE,
      },
      "code-null-refresh": {
        status: 200,
        body: '{"access_token":"li-token","refresh_token":null}',
        contentType: JSON_TYPE,
      },
      "code-expiry-zero": {
        status: 200,
        body: '{"access_token":"li-token","expires_in":0}',
        contentType: JSON_TYPE,
      },
      "code-expiry-negative": {
        status: 200,
        body: '{"access_token":"li-token","expires_in":-1}',
        contentType: JSON_TYPE,
      },
      "code-expiry-float": {
        status: 200,
        body: '{"access_token":"li-token","expires_in":1.5}',
        contentType: JSON_TYPE,
      },
      "code-expiry-string": {
        status: 200,
        body: '{"access_token":"li-token","expires_in":"3600"}',
        contentType: JSON_TYPE,
      },
      "code-expiry-huge": {
        status: 200,
        body: '{"access_token":"li-token","expires_in":9007199254740992}',
        contentType: JSON_TYPE,
      },
      "code-denied": { status: 400, body: '{"error":"invalid_grant"}', contentType: JSON_TYPE },
      "refresh-empty": {
        status: 200,
        body: '{"access_token":"li-new","refresh_token":""}',
        contentType: JSON_TYPE,
      },
      "refresh-absent": {
        status: 200,
        body: '{"access_token":"li-new","expires_in":60}',
        contentType: JSON_TYPE,
      },
      "refresh-rotated": {
        status: 200,
        body: '{"access_token":"li-new","refresh_token":"li-rotated","expires_in":60}',
        contentType: JSON_TYPE,
      },
      "refresh-denied": {
        status: 400,
        body: '{"error":"invalid_grant"}',
        contentType: JSON_TYPE,
      },
      "refresh-padded-token": {
        status: 200,
        body: '{"access_token":" li-new ","refresh_token":"li-rotated"}',
        contentType: JSON_TYPE,
      },
      "refresh-control-refresh": {
        status: 200,
        body: '{"access_token":"li-new","refresh_token":"li\\u0000rotated"}',
        contentType: JSON_TYPE,
      },
    },
  });

export function createOAuthDriverFixture(): {
  readonly handler: (request: Request) => Promise<Response>;
  readonly state: () => OAuthFixtureState;
  readonly reset: () => void;
} {
  let requests: RecordedRequest[] = [];
  let unexpected = 0;

  function reset(): void {
    requests = [];
    unexpected = 0;
  }

  function record(request: Request, body: string): void {
    if (requests.length >= MAX_RECORDED) {
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers.entries()) {
      headers[name] = value;
    }
    requests = [...requests, { method: request.method, url: request.url, headers, body }];
  }

  function operationFor(url: URL): string | null {
    if (url.origin === "https://api.twitter.com" && url.pathname === "/oauth/request_token") {
      return "x-request";
    }
    if (url.origin === "https://api.twitter.com" && url.pathname === "/oauth/access_token") {
      return "x-access";
    }
    if (url.origin === "https://www.tumblr.com" && url.pathname === "/oauth/request_token") {
      return "tumblr-request";
    }
    if (url.origin === "https://www.tumblr.com" && url.pathname === "/oauth/access_token") {
      return "tumblr-access";
    }
    if (url.origin === "https://www.linkedin.com" && url.pathname === "/oauth/v2/accessToken") {
      return "linkedin-token";
    }
    return null;
  }

  function scenarioToken(url: URL, body: string, headers: Headers): string | null {
    if (url.origin === "https://api.twitter.com" || url.origin === "https://www.tumblr.com") {
      const authorization = headers.get("authorization") ?? "";
      const verifier = /oauth_verifier="([^"]*)"/.exec(authorization)?.[1] ?? null;
      if (verifier !== null) {
        return `verifier-${verifier}`;
      }
      const callback = /oauth_callback="([^"]*)"/.exec(authorization)?.[1] ?? null;
      if (callback === null) {
        return null;
      }
      const decoded = decodeURIComponent(callback);
      return /[?&]state=([^&]*)/.exec(decoded)?.[1] ?? null;
    }
    const params = new URLSearchParams(body);
    return params.get("code") ?? params.get("refresh_token");
  }

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.text() : "";

    if (url.origin === "https://stats.invalid") {
      if (url.pathname === "/_reset") {
        reset();
        return Response.json({ ok: true });
      }
      return Response.json({ requests, unexpected });
    }

    record(request, body);
    const operation = operationFor(url);
    if (operation === null) {
      unexpected += 1;
      throw new Error("unexpected outbound destination");
    }
    const scenario = scenarioToken(url, body, request.headers);
    const override = scenario === null ? undefined : SCENARIOS[operation]?.[scenario];
    if (override !== undefined) {
      return new Response(override.body, {
        status: override.status,
        headers: { "content-type": override.contentType },
      });
    }
    const defaults: Record<string, FixtureResponse> = {
      "x-request": X_REQUEST_OK,
      "x-access": X_ACCESS_OK,
      "tumblr-request": TUMBLR_REQUEST_OK,
      "tumblr-access": TUMBLR_ACCESS_OK,
      "linkedin-token": LINKEDIN_TOKEN_OK,
    };
    const fallback = defaults[operation] as FixtureResponse;
    return new Response(fallback.body, {
      status: fallback.status,
      headers: { "content-type": fallback.contentType },
    });
  };

  return { handler, state: () => ({ requests, unexpected }), reset };
}
