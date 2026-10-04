import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LocalProviderError,
  type LocalInstanceObservation,
  type LocalProvider,
} from "@syndroo/core";
import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { previewHumanLines } from "../../src/commands/local/shared.js";
import {
  canonicalDeliveryPayload,
  canonicalJson,
  contentOptionsFor,
  frozenPayloadHash,
  parseLocalPublishDocument,
  type LocalPublishDocument,
} from "../../src/local/document.js";
import {
  buildLocalPublishIntent,
  planLocalPublish,
  previewCapabilitiesFor,
  previewForPlan,
  signLocalPlan,
  type LocalPlanBody,
} from "../../src/local/plan.js";
import type { LocalPlan } from "../../src/local/ports/local-store.js";
import {
  START_TIME,
  connectionRecord,
  deliverOutcome,
  documentOf,
  makeLegacyState,
  openState,
  providerSet,
  seedConnection,
  stateSnapshot,
  succeededOutcome,
  type StateFixture,
  type StaticProvider,
} from "./support/plan-fixture.js";

/**
 * G1: frozen content options, plan/preview metadata, and the schema-1 guards.
 *
 * The store is the real file store; providers are doubles because a plan only
 * ever calls the pure `freeze`/`validateCachedContent` hooks.
 */

const BODY = "# 安全发布工作流\n\n先验证目标账号，再执行已确认的发布。";
const CANONICAL = "https://example.com/posts/safe-publishing";
const MASTODON_TARGET = "mastodon:aHR0cHM6Ly9leGFtcGxlLnNvY2lhbA:1101";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function state(): Promise<StateFixture> {
  const fixture = await openState();

  cleanups.push(fixture.cleanup);

  return fixture;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }

  throw new Error("expected a CliError");
}

function emptyCalls(): {
  freeze: number;
  prepare: number;
  verifyIdentity: number;
} {
  return { freeze: 0, prepare: 0, verifyIdentity: 0 };
}

function articleDocument(
  fields: {
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly canonicalUrl?: string;
    readonly body?: string;
    readonly key?: string;
    readonly summary?: string;
    readonly platforms?: readonly string[];
  } = {},
): LocalPublishDocument {
  const article: Record<string, unknown> = {
    title: fields.title ?? "构建可验证的社媒发布工作流",
  };

  if (fields.tags !== undefined) {
    article["tags"] = fields.tags;
  }

  if (fields.canonicalUrl !== undefined) {
    article["canonicalUrl"] = fields.canonicalUrl;
  }

  return parseLocalPublishDocument(
    JSON.stringify({
      schemaVersion: 2,
      key: fields.key ?? "article-2026-10-04",
      content: fields.summary ?? "摘要：https://example.com/posts/safe-publishing",
      platforms: fields.platforms ?? ["devto"],
      overrides: {
        devto: {
          content: fields.body ?? BODY,
          article,
        },
      },
    }),
  );
}

/** A devto-like provider whose frozen payload really uses the article options. */
function devtoProvider(): StaticProvider {
  const calls = emptyCalls();

  return {
    calls,
    provider: {
      provider: "devto",
      describe: () => ({
        provider: "devto",
        maturity: "fixture-tested",
        localPublish: true,
        unavailableReason: null,
        contentTypes: ["article"],
        authMethods: ["api-key"],
        media: false,
        scheduling: false,
      }),
      freeze: (content, createdAt, options) => {
        calls.freeze++;

        return {
          payloadVersion: 1,
          payload: {
            article: {
              body_markdown: content,
              title: options?.article?.title ?? null,
              tags: options?.article?.tags ?? [],
              canonical_url: options?.article?.canonicalUrl ?? null,
              published: true,
            },
            createdAt,
          },
        };
      },
      verifyIdentity: async () => {
        throw new Error("a preview must not verify an identity");
      },
      prepare: async () => {
        throw new Error("a preview must not prepare a session");
      },
    },
  };
}

function mastodonProvider(
  validate?: (content: string, capabilities: { maxCharacters: number }) => void,
): StaticProvider {
  const calls = emptyCalls();
  const provider: LocalProvider = {
    provider: "mastodon",
    describe: () => ({
      provider: "mastodon",
      maturity: "fixture-tested",
      localPublish: true,
      unavailableReason: null,
      contentTypes: ["text"],
      authMethods: ["user-token", "oauth"],
      media: false,
      scheduling: false,
    }),
    freeze: (content, createdAt) => ({
      payloadVersion: 1,
      payload: { status: content, visibility: "public", createdAt },
    }),
    verifyIdentity: async () => {
      throw new Error("a preview must not verify an identity");
    },
    prepare: async () => {
      throw new Error("a preview must not prepare a session");
    },
  };

  if (validate !== undefined) {
    provider.validateCachedContent = validate;
  }

  return { calls, provider };
}

const OBSERVATION: LocalInstanceObservation = {
  displayName: "Example",
  lastVerifiedAt: START_TIME,
  scopes: ["read", "write"],
  capabilities: { maxCharacters: 500, charactersReservedPerUrl: 23 },
  capabilitySource: "instance-v2",
  capabilityCheckedAt: START_TIME,
  writePermission: "unknown",
};

async function seedMastodon(
  fixture: StateFixture,
  observation?: LocalInstanceObservation,
): Promise<void> {
  await fixture.store.putConnection(
    {
      ...connectionRecord({
        provider: "mastodon",
        targetId: MASTODON_TARGET,
        connectionId: `conn_${"b".repeat(32)}`,
      }),
      schemaVersion: 2,
      ...(observation === undefined ? {} : { observation }),
    },
    null,
  );
}

async function seedDevto(fixture: StateFixture): Promise<void> {
  await fixture.store.putConnection(
    {
      ...connectionRecord({
        provider: "devto",
        targetId: "devto:42",
        connectionId: `conn_${"c".repeat(32)}`,
      }),
      schemaVersion: 2,
    },
    null,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mastodonDocument(key: string): LocalPublishDocument {
  return parseLocalPublishDocument(
    JSON.stringify({
      schemaVersion: 1,
      key,
      content: "hello mastodon",
      platforms: ["mastodon"],
    }),
  );
}

/** Hand-builds the schema-2 plan a legacy state must refuse to store. */
async function schema2Plan(
  fixture: StateFixture,
  document: LocalPublishDocument,
): Promise<LocalPlan> {
  const installation = await fixture.store.getInstallation();
  const target = {
    provider: "devto" as const,
    targetId: "devto:42",
    connectionId: `conn_${"c".repeat(32)}`,
    bindingRevision: 1,
  };
  const contentOptions = contentOptionsFor(document, "devto");
  const frozen =
    contentOptions === undefined
      ? devtoProvider().provider.freeze("x", START_TIME)
      : devtoProvider().provider.freeze(
          document.overrides?.["devto"]?.content ?? "x",
          START_TIME,
          contentOptions,
        );
  const delivery = canonicalDeliveryPayload(document, target, {
    namespace: "default",
    payloadVersion: frozen.payloadVersion,
    payload: frozen.payload,
    ...(contentOptions === undefined ? {} : { contentOptions }),
  });
  const body: LocalPlanBody = {
    schemaVersion: 2,
    installationId: installation.installationId,
    planId: `plan_${"d".repeat(32)}`,
    kind: "publish",
    namespace: "default",
    createdAt: START_TIME,
    expiresAt: new Date(Date.parse(START_TIME) + 86_400_000).toISOString(),
    items: [{ delivery, action: "publish", previousBinding: null }],
    parentOperationId: null,
  };
  const { digest, mac } = await signLocalPlan(body, fixture.store);

  return { ...body, digest, mac };
}

describe("legacy compatibility", () => {
  it("keeps v1 frozen bytes, hash domain, and record schema unchanged", async () => {
    const fixture = await state();
    const set = providerSet();

    await seedConnection(fixture.store, { provider: "bluesky" });

    const plan = await planLocalPublish(documentOf(), {
      store: fixture.store,
      providers: set.providers,
      namespace: "default",
      now: fixture.clock.now,
    });
    const item = plan.items[0];

    expect(plan.schemaVersion).toBe(1);
    expect(item?.delivery.contentOptions).toBeUndefined();
    expect(item?.delivery.payloadHash).toBe(
      sha256(
        canonicalJson({
          payloadVersion: item?.delivery.payloadVersion,
          payload: item?.delivery.payload,
        }),
      ),
    );
    expect(await fixture.store.getInstallation()).toMatchObject({
      schemaVersion: 2,
    });

    // The stored plan record stays schema 1, byte-compatible with the old build.
    const raw = JSON.parse(
      readFileSync(
        path.join(fixture.stateHome, "intents", `${plan.planId}.json`),
        "utf8",
      ),
    ) as { schemaVersion: number };

    expect(raw.schemaVersion).toBe(1);
  });

  it("still plans legacy text from a legacy schema-1 installation", async () => {
    const fixture = await state();

    makeLegacyState(fixture);
    await seedConnection(fixture.store, { provider: "bluesky" });

    const plan = await planLocalPublish(documentOf(), {
      store: fixture.store,
      providers: providerSet().providers,
      namespace: "default",
      now: fixture.clock.now,
    });

    expect(plan.schemaVersion).toBe(1);
  });
});

describe("article options", () => {
  it("binds metadata to the frozen payload hash", async () => {
    const fixture = await state();
    const devto = devtoProvider();

    await seedDevto(fixture);

    const options = {
      store: fixture.store,
      providers: providerSet({ devto }).providers,
      namespace: "default",
      now: fixture.clock.now,
    };
    const first = await planLocalPublish(articleDocument(), options);
    const second = await planLocalPublish(
      articleDocument({ title: "另一个标题" }),
      options,
    );
    const firstItem = first.items[0];
    const secondItem = second.items[0];

    expect(first.schemaVersion).toBe(2);
    expect(firstItem?.delivery.contentOptions).toEqual({
      // Absent optional fields are never materialized as null or empty.
      article: { title: "构建可验证的社媒发布工作流" },
    });
    // Same logical delivery, different approved metadata: never the same hash.
    expect(firstItem?.delivery.deliveryId).toBe(secondItem?.delivery.deliveryId);
    expect(firstItem?.delivery.payloadHash).not.toBe(
      secondItem?.delivery.payloadHash,
    );
    expect(devto.calls.freeze).toBe(2);
  });

  it("does not materialize options for a legacy provider", () => {
    const document = documentOf();
    const target = {
      provider: "bluesky" as const,
      targetId: "did:plc:alice",
      connectionId: `conn_${"a".repeat(32)}`,
      bindingRevision: 1,
    };
    const delivery = canonicalDeliveryPayload(document, target, {
      namespace: "default",
      payloadVersion: 1,
      payload: { text: "x" },
    });

    expect("contentOptions" in delivery).toBe(false);
    expect(Object.keys(delivery).sort()).toEqual(
      [
        "content",
        "deliveryId",
        "key",
        "namespace",
        "payload",
        "payloadHash",
        "payloadVersion",
        "target",
      ].sort(),
    );
    expect(frozenPayloadHash(1, { text: "x" })).toBe(
      sha256(canonicalJson({ payloadVersion: 1, payload: { text: "x" } })),
    );
  });

  it("keeps an explicit empty tag list as zero tags in the frozen options", async () => {
    const fixture = await state();
    const devto = devtoProvider();

    await seedDevto(fixture);

    const options = {
      store: fixture.store,
      providers: providerSet({ devto }).providers,
      namespace: "default",
      now: fixture.clock.now,
    };
    const withEmpty = await planLocalPublish(articleDocument({ tags: [] }), options);
    const omitted = await planLocalPublish(articleDocument(), options);

    expect(withEmpty.items[0]?.delivery.contentOptions).toEqual({
      article: { title: "构建可验证的社媒发布工作流", tags: [] },
    });
    // An explicit zero-tag list is a different approved input than an omitted
    // one, so it must never collapse to the same frozen bytes.
    expect(withEmpty.items[0]?.delivery.payloadHash).not.toBe(
      omitted.items[0]?.delivery.payloadHash,
    );
  });

  it("conflicts on changed metadata and never rewrites the old record", async () => {
    const fixture = await state();
    const devto = devtoProvider();

    await seedDevto(fixture);

    const options = {
      store: fixture.store,
      providers: providerSet({ devto }).providers,
      namespace: "default",
      now: fixture.clock.now,
    };
    const approved = {
      tags: ["typescript", "opensource"],
      canonicalUrl: CANONICAL,
    };
    const first = await planLocalPublish(articleDocument(approved), options);

    await deliverOutcome(fixture.store, first, succeededOutcome("42"));

    const deliveryId = first.items[0]?.delivery.deliveryId as string;
    const recordBefore = await fixture.store.getDelivery(deliveryId);

    for (const changed of [
      articleDocument({ ...approved, title: "changed" }),
      articleDocument({ ...approved, tags: ["opensource", "typescript"] }),
      articleDocument({ ...approved, tags: ["typescript"] }),
      articleDocument({ tags: ["typescript", "opensource"] }),
      articleDocument({ ...approved, body: `${BODY}\n\nmore` }),
    ]) {
      const second = await planLocalPublish(changed, options);
      const item = second.items[0];

      expect(item?.action).toBe("blocked");
      expect(item?.delivery.payloadHash).toBe(
        first.items[0]?.delivery.payloadHash,
      );

      const admission = await rejectionOf(() =>
        fixture.store.reserveOperation(second),
      );

      expect(admission.code).toBe("INVALID_DOCUMENT");
    }

    expect(await fixture.store.getDelivery(deliveryId)).toEqual(recordBefore);

    // The unchanged metadata is a replay, not a conflict.
    const replay = await planLocalPublish(articleDocument(approved), options);

    expect(replay.items[0]?.action).toBe("skip");
  });

  it("freezes the approved source so later mutation cannot change it", async () => {
    const fixture = await state();
    const devto = devtoProvider();

    await seedDevto(fixture);

    const document = articleDocument({ canonicalUrl: CANONICAL });
    const intent = await buildLocalPublishIntent(document, {
      store: fixture.store,
      providers: providerSet({ devto }).providers,
      namespace: "default",
      now: fixture.clock.now,
    });

    // Mutating the parsed document after the intent exists must not change the
    // frozen record the operator is about to confirm.
    (
      document.overrides?.["devto"]?.article as { title: string }
    ).title = "mutated";

    expect(intent.items[0]?.delivery.contentOptions?.article?.title).toBe(
      "构建可验证的社媒发布工作流",
    );
    expect(intent.items[0]?.delivery.content).toBe(BODY);
  });

  it("freezes each target of a mixed v2 document separately", async () => {
    const fixture = await state();
    const devto = devtoProvider();
    const mastodon = mastodonProvider();

    await seedConnection(fixture.store, { provider: "bluesky" });
    await seedMastodon(fixture, OBSERVATION);
    await seedDevto(fixture);

    const intent = await buildLocalPublishIntent(
      articleDocument({ platforms: ["bluesky", "mastodon", "devto"] }),
      {
        store: fixture.store,
        providers: providerSet({ devto, mastodon }).providers,
        namespace: "default",
        now: fixture.clock.now,
      },
    );

    expect(intent.schemaVersion).toBe(2);
    expect(intent.items.map(item => item.delivery.target.provider)).toEqual([
      "bluesky",
      "mastodon",
      "devto",
    ]);

    const byProvider = new Map(
      intent.items.map(item => [item.delivery.target.provider, item.delivery]),
    );

    // The text providers freeze the summary; only devto freezes the article.
    expect(byProvider.get("bluesky")?.content).toBe(
      "摘要：https://example.com/posts/safe-publishing",
    );
    expect(byProvider.get("mastodon")?.content).toBe(
      "摘要：https://example.com/posts/safe-publishing",
    );
    expect(byProvider.get("devto")?.content).toBe(BODY);
    expect(byProvider.get("bluesky")?.contentOptions).toBeUndefined();
    expect(byProvider.get("mastodon")?.contentOptions).toBeUndefined();
    expect(byProvider.get("devto")?.contentOptions?.article?.title).toBe(
      "构建可验证的社媒发布工作流",
    );
  });
});

describe("full preview", () => {
  it("shows the account, title, full Markdown, ordered tags, canonical, and visibility", async () => {
    const fixture = await state();
    const devto = devtoProvider();

    await seedDevto(fixture);

    const intent = await buildLocalPublishIntent(
      articleDocument({
        tags: ["typescript", "opensource"],
        canonicalUrl: CANONICAL,
      }),
      {
        store: fixture.store,
        providers: providerSet({ devto }).providers,
        namespace: "default",
        now: fixture.clock.now,
      },
    );
    const preview = previewForPlan(intent);
    const item = preview.items[0];

    expect(item?.targetId).toBe("devto:42");
    expect(item?.visibility).toBe("public");
    expect(item?.article).toEqual({
      title: "构建可验证的社媒发布工作流",
      tags: ["typescript", "opensource"],
      canonicalUrl: CANONICAL,
    });
    expect(item?.content).toBe(BODY);

    const human = previewHumanLines(
      "publish",
      preview,
      intent.items.map(() => null),
    ).join("\n");

    expect(human).toContain("visibility public");
    expect(human).toContain("title    构建可验证的社媒发布工作流");
    expect(human).toContain("tags     typescript, opensource");
    expect(human).toContain(`canonical ${CANONICAL}`);
    expect(human).toContain("content | # 安全发布工作流");
  });

  it("keeps legacy text previews byte-compatible", async () => {
    const fixture = await state();

    await seedConnection(fixture.store, { provider: "bluesky" });

    const plan = await planLocalPublish(documentOf(), {
      store: fixture.store,
      providers: providerSet().providers,
      namespace: "default",
      now: fixture.clock.now,
    });
    const item = previewForPlan(plan).items[0];

    expect(item === undefined ? {} : Object.keys(item).sort()).toEqual(
      [
        "action",
        "binding",
        "content",
        "key",
        "previousBinding",
        "provider",
        "targetId",
      ].sort(),
    );
  });
});

describe("mastodon cached capabilities", () => {
  it("requires a cached snapshot for a new target", async () => {
    const fixture = await state();
    const mastodon = mastodonProvider();

    await seedMastodon(fixture);

    const error = await rejectionOf(() =>
      planLocalPublish(mastodonDocument("mastodon-1"), {
        store: fixture.store,
        providers: providerSet({ mastodon }).providers,
        namespace: "default",
        now: fixture.clock.now,
      }),
    );

    expect(error.code).toBe("PROVIDER_LOCAL_UNAVAILABLE");
  });

  it("reports the cached source/time and public visibility in the preview", async () => {
    const fixture = await state();
    const mastodon = mastodonProvider();

    await seedMastodon(fixture, OBSERVATION);

    const intent = await buildLocalPublishIntent(
      mastodonDocument("mastodon-2"),
      {
        store: fixture.store,
        providers: providerSet({ mastodon }).providers,
        namespace: "default",
        now: fixture.clock.now,
      },
    );
    const capabilities = await previewCapabilitiesFor(fixture.store, intent);
    const item = previewForPlan(intent, { capabilities }).items[0];

    expect(item?.visibility).toBe("public");
    expect(item?.capabilities).toEqual({
      source: "instance-v2",
      checkedAt: START_TIME,
    });
    expect(item?.article).toBeUndefined();
  });

  it("delegates the platform length algorithm to the adapter hook", async () => {
    const fixture = await state();
    const mastodon = mastodonProvider(() => {
      throw new LocalProviderError("INVALID_CONTENT");
    });

    await seedMastodon(fixture, OBSERVATION);

    const error = await rejectionOf(() =>
      planLocalPublish(mastodonDocument("mastodon-3"), {
        store: fixture.store,
        providers: providerSet({ mastodon }).providers,
        namespace: "default",
        now: fixture.clock.now,
      }),
    );

    // The hook is the adapter's; a rejection surfaces as an admission failure.
    expect(error.code).toBe("INVALID_DOCUMENT");
  });
});

describe("schema-1 state guards", () => {
  it("refuses new fields and schema-2 records before anything is saved", async () => {
    const fixture = await state();

    makeLegacyState(fixture);

    const before = stateSnapshot(fixture.stateHome);

    const connection = await rejectionOf(() =>
      fixture.store.putConnection(
        {
          ...connectionRecord({ provider: "threads" }),
          schemaVersion: 2,
          observation: OBSERVATION,
        },
        null,
      ),
    );

    expect(connection.code).toBe("STATE_VERSION_UNSUPPORTED");

    const observation = await rejectionOf(() =>
      fixture.store.putObservation("threads", OBSERVATION, 1),
    );

    expect(observation.code).toBe("STATE_VERSION_UNSUPPORTED");

    const plan = await schema2Plan(fixture, articleDocument());
    const putPlan = await rejectionOf(() => fixture.store.putPlan(plan));

    expect(putPlan.code).toBe("STATE_VERSION_UNSUPPORTED");

    const reserve = await rejectionOf(() =>
      fixture.store.reserveOperation(plan),
    );

    expect(reserve.code).toBe("STATE_VERSION_UNSUPPORTED");
    expect(stateSnapshot(fixture.stateHome)).toEqual(before);
  });
});

describe("putObservation", () => {
  it("refreshes the cache without touching the binding revision or history", async () => {
    const fixture = await state();

    await seedConnection(fixture.store, { provider: "threads" });

    const before = await fixture.store.getConnection("threads");
    const snapshotBefore = stateSnapshot(fixture.stateHome);

    await fixture.store.putObservation("threads", OBSERVATION, 1);

    const after = await fixture.store.getConnection("threads");

    expect(after?.observation).toEqual(OBSERVATION);
    expect(after?.target.bindingRevision).toBe(before?.target.bindingRevision);
    expect(after?.fingerprint).toBe(before?.fingerprint);
    expect(after?.source).toEqual(before?.source);
    // Only the one connection record changed; no plan, delivery, or receipt did.
    const strip = (entries: readonly string[]): readonly string[] =>
      entries.filter(
        entry => !entry.startsWith("connections/threads.json:"),
      );

    expect(strip(stateSnapshot(fixture.stateHome))).toEqual(
      strip(snapshotBefore),
    );
  });

  it("refuses a stale revision and a removed binding", async () => {
    const fixture = await state();

    await seedConnection(fixture.store, { provider: "threads" });

    const stale = await rejectionOf(() =>
      fixture.store.putObservation("threads", OBSERVATION, 2),
    );

    expect(stale.code).toBe("BINDING_CHANGED");
    expect(
      (await fixture.store.getConnection("threads"))?.observation,
    ).toBeUndefined();

    await seedConnection(fixture.store, {
      provider: "threads",
      bindingRevision: 2,
      removed: true,
      expectedRevision: 1,
    });

    const removed = await rejectionOf(() =>
      fixture.store.putObservation("threads", OBSERVATION, 2),
    );

    expect(removed.code).toBe("BINDING_CHANGED");
  });
});
