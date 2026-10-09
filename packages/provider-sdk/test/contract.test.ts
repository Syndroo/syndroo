import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import type { ContractCase, ProviderWriteOutcome } from "../src/index.js";
import {
  CONTRACT_TEST_CREDENTIAL_CANARY,
  ProviderContractError,
  deepFreeze,
  providerContractTests,
  validateFrozenProviderPayload,
  validateProviderWriteOutcome,
} from "../src/testing.js";
import {
  FAKE_ACCOUNT,
  FAKE_PROVIDER_VERSION,
  FAKE_SECRET_CANARY,
  createFakeCases,
  createFakeProvider,
  createFakeTransport,
  fakeFreezeInput,
} from "../../../tests/fixtures/providers/fake.js";

/** Run the harness and return the raised contract error. */
async function contractFailure(
  plugin = createFakeProvider(),
  cases: readonly ContractCase[] = createFakeCases(),
  packageVersion: string = FAKE_PROVIDER_VERSION,
): Promise<ProviderContractError> {
  try {
    await providerContractTests({ plugin, packageVersion, cases });
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderContractError);
    return error as ProviderContractError;
  }
  throw new Error("expected providerContractTests to reject");
}

describe("providerContractTests", () => {
  it("accepts the deterministic fake and reports how many checks ran", async () => {
    const result = await providerContractTests({
      plugin: createFakeProvider(),
      packageVersion: FAKE_PROVIDER_VERSION,
      cases: createFakeCases(),
    });

    expect(result.checks).toBeGreaterThan(20);
  });

  it("requires a case and a matching package version", async () => {
    const noCases = await contractFailure(createFakeProvider(), []);
    expect(noCases.code).toBe("no_cases");

    const versionMismatch = await contractFailure(createFakeProvider(), createFakeCases(), "9.9.9");
    expect(versionMismatch.code).toBe("version_mismatch");
  });

  it("rejects a definition the manifest validator would reject", async () => {
    const plugin = createFakeProvider({ version: "2.0.0" });
    const cases = createFakeCases();

    // The same plugin passes when its version argument agrees, so the failure
    // below is the manifest check and not the version comparison.
    await expect(
      providerContractTests({ plugin, packageVersion: "2.0.0", cases }),
    ).resolves.toMatchObject({ checks: expect.any(Number) });

    const badApi = await contractFailure(
      { ...plugin, manifest: { ...plugin.manifest, apiVersion: 2 } } as never,
      cases,
      "2.0.0",
    );
    expect(badApi.code).toBe("invalid_manifest");
  });

  it("rejects a malformed freeze payload and a mutable one", async () => {
    const cases = createFakeCases();
    const base = createFakeProvider().freeze(cases[0]!.input);

    const wrongVersion = await contractFailure(
      createFakeProvider({ freeze: () => deepFreeze({ ...base, payloadVersion: 2 }) as never }),
      cases,
    );
    expect(wrongVersion.code).toBe("malformed_payload");

    const mutable = await contractFailure(
      createFakeProvider({ freeze: () => structuredClone(base) }),
      cases,
    );
    expect(mutable.code).toBe("mutable_payload");
  });

  it("rejects a preview that hides an effective option", async () => {
    const cases = createFakeCases();
    const base = createFakeProvider().freeze(cases[0]!.input);
    const hiddenOption = deepFreeze({
      ...base,
      effectiveOptions: { ...base.effectiveOptions, visibility: "public" },
      preview: {
        content: base.preview.content,
        fields: base.preview.fields.filter((field) => field.name !== "visibility"),
      },
    });

    const failure = await contractFailure(createFakeProvider({ freeze: () => hiddenOption }), cases);

    expect(failure.code).toBe("incomplete_preview");
  });

  it("rejects a freeze that mutates its input, throws or is not deterministic", async () => {
    const cases = createFakeCases();

    const mutating = await contractFailure(
      createFakeProvider({
        freeze: (input) => {
          const payload = createFakeProvider().freeze(input);
          (input as { seed: string }).seed = "mutated";
          return payload;
        },
      }),
      cases,
    );
    expect(mutating.code).toBe("input_mutated");

    const throwing = await contractFailure(
      createFakeProvider({
        freeze: () => {
          throw new Error("fixture freeze failure");
        },
      }),
      cases,
    );
    expect(throwing.code).toBe("freeze_threw");

    let calls = 0;
    const nondeterministic = await contractFailure(
      createFakeProvider({
        freeze: (input) => {
          calls += 1;
          const base = createFakeProvider().freeze(input);
          return deepFreeze({ ...base, payload: { ...base.payload, attempt: calls } });
        },
      }),
      cases,
    );
    expect(nondeterministic.code).toBe("nondeterministic_freeze");
  });

  it("rejects a payload that differs from the recorded expectation", async () => {
    const cases = createFakeCases();
    const tampered: ContractCase[] = cases.map((entry) => ({
      ...entry,
      expected: deepFreeze({
        ...entry.expected,
        payload: { ...entry.expected.payload, digest: "fnv1a_00000000" },
      }),
    }));

    const failure = await contractFailure(createFakeProvider(), tampered);

    expect(failure.code).toBe("expected_mismatch");
  });

  it("rejects auth material in a frozen payload", async () => {
    const cases = createFakeCases();
    const leaked = await contractFailure(
      createFakeProvider({
        freeze: (input) => {
          const base = createFakeProvider().freeze(input);
          return deepFreeze({ ...base, payload: { ...base.payload, accessToken: FAKE_SECRET_CANARY } });
        },
      }),
      cases,
    );

    expect(leaked.code).toBe("auth_material_in_payload");
    expect(leaked.message).not.toContain(FAKE_SECRET_CANARY);
  });

  it("rejects a malformed outcome, an unknown marked retryable and a credential leak", async () => {
    const cases = createFakeCases();

    const malformed = await contractFailure(
      createFakeProvider({ publish: async () => ({ status: "ok" }) as unknown as ProviderWriteOutcome }),
      cases,
    );
    expect(malformed.code).toBe("malformed_outcome");

    const unknownRetryable = await contractFailure(
      createFakeProvider({
        publish: async () =>
          ({ status: "unknown", disposition: "unknown", reason: "network", retryable: true }) as unknown as ProviderWriteOutcome,
      }),
      cases,
    );
    expect(unknownRetryable.code).toBe("unknown_marked_retryable");

    const leaking = await contractFailure(
      createFakeProvider({
        publish: async () => ({
          status: "succeeded",
          remoteId: "fake_1",
          url: `https://fake.example/${CONTRACT_TEST_CREDENTIAL_CANARY}`,
        }),
      }),
      cases,
    );
    expect(leaking.code).toBe("credential_leaked");
  });

  it("rejects a publish that throws instead of returning an outcome", async () => {
    const failure = await contractFailure(
      createFakeProvider({
        publish: async () => {
          throw new Error("fixture publish failure");
        },
      }),
      createFakeCases(),
    );

    expect(failure.code).toBe("publish_threw");
  });

  it("leaves the caller's case inputs untouched", async () => {
    const cases = createFakeCases();
    const before = structuredClone(cases.map((entry) => entry.input));

    await providerContractTests({
      plugin: createFakeProvider(),
      packageVersion: FAKE_PROVIDER_VERSION,
      cases,
    });

    expect(cases.map((entry) => entry.input)).toStrictEqual(before);
  });
});

describe("freeze determinism and content preservation", () => {
  it("produces identical payloads from two independently built plugins", () => {
    const input = fakeFreezeInput();

    const first = createFakeProvider().freeze(structuredClone(input));
    const second = createFakeProvider().freeze(structuredClone(input));

    expect(isDeepStrictEqual(first, second)).toBe(true);
    expect(first.payload.digest).toBe(second.payload.digest);
  });

  it("separates two seeds and two accounts", () => {
    const base = createFakeProvider().freeze(fakeFreezeInput());
    const otherSeed = createFakeProvider().freeze(fakeFreezeInput({ seed: "seed_fake_0002" }));
    const otherAccount = createFakeProvider().freeze(
      fakeFreezeInput({ account: { provider: "fake", accountId: "acct_fake_0002", origin: "https://fake.example" } }),
    );

    expect(base.payload.digest).not.toBe(otherSeed.payload.digest);
    expect(base.payload.digest).not.toBe(otherAccount.payload.digest);
  });

  it("keeps every user-visible article field, verbatim and un-ellipsised", () => {
    const body = "The full article body, preserved verbatim by the fixture.";
    const input = fakeFreezeInput({
      text: "Fake article summary.",
      options: {
        visibility: "unlisted",
        title: "A fixture article",
        body,
        tags: ["fixtures", "contract"],
        canonicalUrl: "https://example.test/fixture-article",
      },
    });

    const payload = createFakeProvider().freeze(input);
    const fields = new Map(payload.preview.fields.map((field) => [field.name, field.value]));

    expect(payload.preview.content).toStrictEqual(payload.effectiveContent);
    expect(fields.get("body")).toBe(body);
    expect(fields.get("title")).toBe("A fixture article");
    expect(fields.get("tags")).toStrictEqual(["fixtures", "contract"]);
    expect(fields.get("canonicalUrl")).toBe("https://example.test/fixture-article");
    expect(fields.get("visibility")).toBe("unlisted");
    for (const value of fields.values()) {
      expect(JSON.stringify(value)).not.toContain("…");
    }
    expect(isDeepStrictEqual(input.options, {
      visibility: "unlisted",
      title: "A fixture article",
      body,
      tags: ["fixtures", "contract"],
      canonicalUrl: "https://example.test/fixture-article",
    })).toBe(true);
  });

  it("expands defaults into effective options without dropping the supplied ones", () => {
    const payload = createFakeProvider().freeze(fakeFreezeInput({ options: { title: "Only a title" } }));

    expect(payload.effectiveOptions).toMatchObject({ title: "Only a title", visibility: "public" });
    expect(payload.preview.fields.map((field) => field.name)).toContain("visibility");
  });
});

describe("fake write outcomes", () => {
  const publishWith = async (result: Parameters<typeof createFakeTransport>[0]) => {
    const plugin = createFakeProvider();
    const payload = plugin.freeze(fakeFreezeInput());
    return plugin.publish({
      frozen: payload,
      account: fakeFreezeInput().account,
      credentials: { canary: CONTRACT_TEST_CREDENTIAL_CANARY },
      submissionId: "seed_fake_0001",
      context: { now: "2026-10-08T00:00:00.000Z", signal: new AbortController().signal, transport: createFakeTransport(result) },
    });
  };

  it("maps a pre-send transport error to a retryable not_applied result", async () => {
    const outcome = await publishWith({ type: "transport_error", stage: "before_request", code: "offline" });

    expect(outcome).toStrictEqual({
      status: "failed",
      disposition: "not_applied",
      retryable: true,
      reason: "network",
    });
  });

  it("keeps a possibly-sent failure and a 5xx answer unknown and non-retryable", async () => {
    const possiblySent = await publishWith({ type: "transport_error", stage: "possibly_sent", code: "timeout" });
    const serverError = await publishWith({ type: "response", status: 503, headers: {}, body: "{}" });

    expect(possiblySent.status).toBe("unknown");
    expect(serverError.status).toBe("unknown");
    for (const outcome of [possiblySent, serverError]) {
      expect(outcome).not.toHaveProperty("retryable");
      expect(() => validateProviderWriteOutcome(outcome)).not.toThrow();
    }
  });

  it("reports a 2xx answer as succeeded with the submission-derived id", async () => {
    const outcome = await publishWith({ type: "response", status: 200, headers: {}, body: "{}" });

    expect(outcome).toMatchObject({ status: "succeeded", remoteId: "fake_seed_fake_0001" });
  });

  it("is deterministic for the same transport result", async () => {
    const result = { type: "response", status: 401, headers: {}, body: "" } as const;

    expect(await publishWith(result)).toStrictEqual(await publishWith(result));
  });
});

describe("surface guarantees", () => {
  it("rejects a payload or outcome that is not shaped as declared", () => {
    expect(() => validateFrozenProviderPayload({ payloadVersion: 1 })).toThrow(ProviderContractError);
    expect(() => validateFrozenProviderPayload(createFakeProvider().freeze(fakeFreezeInput()))).not.toThrow();
    expect(() => validateProviderWriteOutcome({ status: "succeeded", remoteId: 7 })).toThrow(ProviderContractError);
    expect(() =>
      validateProviderWriteOutcome({ status: "failed", disposition: "applied", retryable: false, reason: "auth" }),
    ).toThrow(ProviderContractError);
  });

  it("keeps the testing subpath out of the production dependency graph", async () => {
    const source = async (file: string): Promise<string> => {
      const text = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
      // Doc comments mention the subpath on purpose; only real specifiers count.
      return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    };
    const [index, types, define] = await Promise.all([
      source("index.ts"),
      source("types.ts"),
      source("define-provider.ts"),
    ]);

    for (const [name, text] of [
      ["index.ts", index],
      ["types.ts", types],
      ["define-provider.ts", define],
    ] as const) {
      const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect(specifiers.some((specifier) => specifier?.includes("testing")), `${name} imports the testing subpath`)
        .toBe(false);
      expect(text).not.toContain("node:util");
      expect(text).not.toContain("node:fs");
      expect(text).not.toContain("node:child_process");
    }
    const indexSpecifiers = [...new Set([...index.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]))];
    expect(indexSpecifiers.sort()).toStrictEqual(["./define-provider.js", "./types.js"]);
  });

  it("never writes a credential canary into an outcome or a frozen payload", async () => {
    const payload = createFakeProvider().freeze(fakeFreezeInput());
    const outcome = await createFakeProvider().publish({
      frozen: payload,
      account: fakeFreezeInput().account,
      credentials: { canary: FAKE_SECRET_CANARY },
      submissionId: "seed_fake_0001",
      context: {
        now: "2026-10-08T00:00:00.000Z",
        signal: new AbortController().signal,
        transport: createFakeTransport({ type: "response", status: 200, headers: {}, body: "{}" }),
      },
    });

    for (const value of [payload, outcome]) {
      expect(JSON.stringify(value)).not.toContain(FAKE_SECRET_CANARY);
      expect(JSON.stringify(value)).not.toContain(CONTRACT_TEST_CREDENTIAL_CANARY);
    }
  });
});

describe("write outcome variant strictness", () => {
  const succeeded = { status: "succeeded", remoteId: "remote_1", url: "https://fake.example/remote_1" } as const;
  const failed = { status: "failed", disposition: "not_applied", retryable: false, reason: "auth" } as const;
  const unknown = { status: "unknown", disposition: "unknown", reason: "network" } as const;

  it("accepts each well-formed variant, including a real ISO retryAfter", () => {
    expect(() => validateProviderWriteOutcome({ ...succeeded })).not.toThrow();
    expect(() => validateProviderWriteOutcome({ ...failed })).not.toThrow();
    expect(() => validateProviderWriteOutcome({ ...unknown })).not.toThrow();
    // Offsets and fractional seconds are ISO 8601 too, not only `toISOString` UTC.
    expect(() => validateProviderWriteOutcome({ ...failed, retryAfter: "2026-10-08T00:00:30.500Z" })).not.toThrow();
    expect(() => validateProviderWriteOutcome({ ...failed, retryAfter: "2026-10-08T09:00:30+09:00" })).not.toThrow();
  });

  it("rejects a succeeded outcome that carries a failure field", () => {
    for (const extra of [
      { disposition: "not_applied" },
      { retryable: false },
      { reason: "unknown" },
      { retryAfter: "2026-10-08T00:01:00.000Z" },
    ]) {
      expect(() => validateProviderWriteOutcome({ ...succeeded, ...extra })).toThrow(ProviderContractError);
    }
    expect(() => validateProviderWriteOutcome({ ...succeeded, ...{ disposition: "unknown" } })).toThrow(
      ProviderContractError,
    );
  });

  it("rejects an unknown outcome that carries a retry hint", () => {
    expect(() => validateProviderWriteOutcome({ ...unknown, retryAfter: "2026-10-08T00:01:00.000Z" })).toThrow(
      ProviderContractError,
    );
    // The specific code is preserved so callers can branch on it.
    try {
      validateProviderWriteOutcome({ ...unknown, retryable: true });
      throw new Error("expected the retryable check to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderContractError);
      expect((error as ProviderContractError).code).toBe("unknown_marked_retryable");
    }
  });

  it("rejects a failed outcome whose retryAfter is not an ISO 8601 date-time", () => {
    for (const retryAfter of ["nonsense", "2026-10-08", "2026-13-45T99:99:99Z", "", 1_000]) {
      expect(() => validateProviderWriteOutcome({ ...failed, retryAfter })).toThrow(ProviderContractError);
    }
  });

  it("rejects an unknown status and a status-less object", () => {
    expect(() => validateProviderWriteOutcome({ status: "ok" })).toThrow(ProviderContractError);
    expect(() => validateProviderWriteOutcome({ disposition: "unknown", reason: "network" })).toThrow(
      ProviderContractError,
    );
  });

  it("makes the harness fail on a cross-variant outcome instead of the expectation", async () => {
    const succeededRetryable = await contractFailure(
      createFakeProvider({
        publish: async () => ({ ...succeeded, retryable: false }) as unknown as ProviderWriteOutcome,
      }),
      createFakeCases(),
    );
    expect(succeededRetryable.code).toBe("malformed_outcome");

    const nonsenseRetryAfter = await contractFailure(
      createFakeProvider({
        publish: async () => ({ ...failed, retryAfter: "nonsense" }) as unknown as ProviderWriteOutcome,
      }),
      createFakeCases(),
    );
    expect(nonsenseRetryAfter.code).toBe("malformed_outcome");
  });

  it("gives the fake account an HTTPS origin Core invariants can accept", () => {
    for (const account of [FAKE_ACCOUNT, ...createFakeCases().map((entry) => entry.input.account)]) {
      const url = new URL(account.origin);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("fake.example");
    }
  });
});
