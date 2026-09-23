import { describe, expect, it } from "vitest";

import { InvalidContractInputError, validateCreatePostTransaction } from "../src/index.js";
import { createTransaction, FIXTURE_NOW } from "../src/testing/index.js";

describe("create transaction validation", () => {
  it("accepts a transaction with and without an idempotency key", () => {
    expect(() => validateCreatePostTransaction(createTransaction())).not.toThrow();
    expect(() =>
      validateCreatePostTransaction(createTransaction({ key: null })),
    ).not.toThrow();
    // The public header is optional, so an empty key is not "invalid key" but
    // "no key" for the API layer; the port receives null.
    expect(() =>
      validateCreatePostTransaction(createTransaction({ key: "a".repeat(128) })),
    ).not.toThrow();
  });

  it("rejects keys outside the documented header charset", () => {
    expect(() =>
      validateCreatePostTransaction(createTransaction({ key: "bad key" })),
    ).toThrow(InvalidContractInputError);
    expect(() =>
      validateCreatePostTransaction(createTransaction({ key: "bad/key" })),
    ).toThrow(InvalidContractInputError);
    expect(() =>
      validateCreatePostTransaction(createTransaction({ key: "a".repeat(129) })),
    ).toThrow(InvalidContractInputError);
  });

  it("rejects two jobs for one publication", () => {
    const base = createTransaction();
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        jobs: [
          {
            id: "job_0001",
            kind: "delivery.execute",
            aggregateId: "pub_0001",
            attemptNo: 1,
            availableAt: FIXTURE_NOW,
          },
          {
            id: "job_0002",
            kind: "delivery.execute",
            aggregateId: "pub_0001",
            attemptNo: 1,
            availableAt: FIXTURE_NOW,
          },
        ],
      }),
    ).toThrow(InvalidContractInputError);
  });

  it("rejects a publication without its own job", () => {
    const base = createTransaction();
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        publications: [
          ...base.publications,
          {
            id: "pub_0002",
            postId: base.post.id,
            platform: "bluesky",
            provider: "bluesky-provider",
            content: "second",
            status: "pending",
            scheduledAt: null,
            credentialBinding: "binding-hmac-0002",
            credentialRevision: 0,
            createdAt: FIXTURE_NOW,
          },
        ],
      }),
    ).toThrow(InvalidContractInputError);
  });

  it("rejects a requested platform without a publication or a guard", () => {
    const base = createTransaction();
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        post: { ...base.post, platforms: ["x", "bluesky"] },
      }),
    ).toThrow(InvalidContractInputError);

    expect(() =>
      validateCreatePostTransaction({ ...base, credentialGuards: [] }),
    ).toThrow(InvalidContractInputError);
  });

  it("rejects duplicate platforms, duplicate ids and extraneous guards", () => {
    const base = createTransaction();
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        post: { ...base.post, platforms: ["x", "x"] },
        publications: [
          base.publications[0] as never,
          {
            ...(base.publications[0] as object),
            id: "pub_0002",
          } as never,
        ],
        jobs: [
          ...base.jobs,
          { ...base.jobs[0]!, id: "job_0002", aggregateId: "pub_0002" },
        ],
        credentialGuards: [
          { platform: "x", expectedRevision: 0, bindingId: null },
          { platform: "bluesky", expectedRevision: 0, bindingId: null },
        ],
      }),
    ).toThrow(InvalidContractInputError);
  });

  it("rejects a guard for a platform that is not targeted", () => {
    const base = createTransaction();
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        credentialGuards: [
          { platform: "x", expectedRevision: 0, bindingId: null },
          { platform: "bluesky", expectedRevision: 0, bindingId: null },
        ],
      }),
    ).toThrow(InvalidContractInputError);
  });

  it("rejects drift between a publication revision and its credential guard", () => {
    const base = createTransaction();
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        publications: base.publications.map((publication) => ({
          ...publication,
          credentialRevision: 1,
        })),
        credentialGuards: [{ platform: "x", expectedRevision: 0, bindingId: null }],
      }),
    ).toThrow(InvalidContractInputError);
    // The same values stay valid when both sides agree.
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        publications: base.publications.map((publication) => ({
          ...publication,
          credentialRevision: 1,
        })),
        credentialGuards: [{ platform: "x", expectedRevision: 1, bindingId: null }],
      }),
    ).not.toThrow();
  });

  it("rejects a non-canonical schedule intent", () => {
    const base = createTransaction();
    expect(() =>
      validateCreatePostTransaction({
        ...base,
        post: { ...base.post, scheduledAt: "2026-09-23T00:00:00Z" as never },
        publications: base.publications.map((publication) => ({
          ...publication,
          scheduledAt: "2026-09-23T00:00:00Z" as never,
        })),
      }),
    ).toThrow(InvalidContractInputError);
  });
});
