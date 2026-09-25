import { TextEncoder } from "node:util";

import { describe, expect, it } from "vitest";

import { CliError } from "../../src/cli-error.js";
import { parsePostDocument, sha256 } from "../../src/document.js";
import { EXIT_CODE } from "../../src/exit-codes.js";
import {
  MAX_LOCAL_CONTENT_CODE_POINTS,
  MAX_LOCAL_SOURCE_BYTES,
  canonicalDeliveryPayload,
  canonicalJson,
  decodeLocalSource,
  parseLocalJson,
  parseLocalPublishDocument,
} from "../../src/local/document.js";

const KEY = "syndroo-v060-announcement-001";

/** Documented contract literals; the exported constants must equal these. */
const SOURCE_LIMIT = 65_536;
const CONTENT_LIMIT = 10_000;

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }

  return joined;
}

function errorOf(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }

  throw new Error("expected a CliError");
}

function codeOf(run: () => unknown): string {
  return errorOf(run).code;
}

/** A valid document, with individual fields replaceable. */
function documentText(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    key: KEY,
    content: "Syndroo 正在转向 CLI-first：让 Agent 直接完成跨平台发布。",
    platforms: ["bluesky", "threads"],
    overrides: { bluesky: { content: "Syndroo：CLI-first，Agent-ready。" } },
    ...fields,
  });
}

describe("parseLocalPublishDocument", () => {
  it("matches the documented limits", () => {
    expect(MAX_LOCAL_SOURCE_BYTES).toBe(SOURCE_LIMIT);
    expect(MAX_LOCAL_CONTENT_CODE_POINTS).toBe(CONTENT_LIMIT);
  });

  it("accepts a document and keeps the content byte for byte", () => {
    const document = parseLocalPublishDocument(documentText());

    expect(document.schemaVersion).toBe(1);
    expect(document.key).toBe(KEY);
    expect(document.content).toBe(
      "Syndroo 正在转向 CLI-first：让 Agent 直接完成跨平台发布。",
    );
    expect(document.platforms).toEqual(["bluesky", "threads"]);
    expect(document.overrides?.["bluesky"]?.content).toBe(
      "Syndroo：CLI-first，Agent-ready。",
    );
  });

  it("never trims or rewrites content", () => {
    const content = "  leading and trailing  \n";
    const document = parseLocalPublishDocument(
      documentText({ content, overrides: undefined }),
    );

    expect(document.content).toBe(content);
  });

  it("rejects a root that is not an object", () => {
    for (const root of ["[]", "null", "3", '"text"', "true"]) {
      expect(codeOf(() => parseLocalPublishDocument(root))).toBe(
        "INVALID_DOCUMENT",
      );
    }
  });

  it("rejects unknown fields without echoing them", () => {
    const error = errorOf(() =>
      parseLocalPublishDocument(documentText({ media: ["a.png"] })),
    );

    expect(error.code).toBe("INVALID_DOCUMENT");
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).not.toContain("media");
  });

  it("rejects scheduled publishing with its own code", () => {
    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          documentText({ scheduledAt: "2030-01-01T00:00:00Z" }),
        ),
      ),
    ).toBe("LOCAL_SCHEDULING_UNSUPPORTED");
  });

  it("rejects blank content", () => {
    for (const content of ["", "   ", "\n\t "]) {
      expect(
        codeOf(() =>
          parseLocalPublishDocument(
            documentText({ content, overrides: undefined }),
          ),
        ),
      ).toBe("INVALID_DOCUMENT");
    }
  });

  it("counts content in code points, not UTF-16 units", () => {
    const emoji = "\u{1F600}";
    const atLimit = emoji.repeat(CONTENT_LIMIT);
    const document = parseLocalPublishDocument(
      documentText({ content: atLimit, overrides: undefined }),
    );

    expect(document.content.length).toBe(CONTENT_LIMIT * 2);

    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          documentText({
            content: emoji.repeat(CONTENT_LIMIT + 1),
            overrides: undefined,
          }),
        ),
      ),
    ).toBe("INVALID_DOCUMENT");
  });

  it("enforces the key pattern", () => {
    for (const key of ["", "-leading", "with space", "a".repeat(129)]) {
      expect(codeOf(() => parseLocalPublishDocument(documentText({ key })))).toBe(
        "INVALID_DOCUMENT",
      );
    }

    for (const key of ["a", "A1._:-", "a".repeat(128)]) {
      expect(parseLocalPublishDocument(documentText({ key })).key).toBe(key);
    }
  });

  it("rejects an empty, repeated, or unknown platform list", () => {
    for (const platforms of [
      [],
      ["bluesky", "bluesky"],
      ["bluesky", 7],
      ["mastodon"],
    ]) {
      expect(
        codeOf(() =>
          parseLocalPublishDocument(
            documentText({ platforms, overrides: undefined }),
          ),
        ),
      ).toBe("INVALID_DOCUMENT");
    }
  });

  it("reports known remote-only platforms as locally unavailable", () => {
    for (const platform of ["x", "tumblr", "linkedin"]) {
      const error = errorOf(() =>
        parseLocalPublishDocument(
          documentText({ platforms: [platform], overrides: undefined }),
        ),
      );

      expect(error.code).toBe("PROVIDER_LOCAL_UNAVAILABLE");
      expect(error.message).not.toContain(platform);
    }
  });

  it("rejects an override that does not match a selected platform", () => {
    for (const overrides of [
      { threads: { content: "not selected" } },
      { bluesky: { content: "ok", extra: true } },
      { bluesky: { content: "" } },
      { bluesky: "not an object" },
      { bluesky: {} },
    ]) {
      expect(
        codeOf(() =>
          parseLocalPublishDocument(
            documentText({ platforms: ["bluesky"], overrides }),
          ),
        ),
      ).toBe("INVALID_DOCUMENT");
    }
  });

  it("rejects repeated keys, including escaped equivalents", () => {
    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          '{"schemaVersion":1,"key":"k","key":"other","content":"c","platforms":["bluesky"]}',
        ),
      ),
    ).toBe("INVALID_DOCUMENT");

    expect(
      codeOf(() =>
        parseLocalPublishDocument(
          '{"schemaVersion":1,"key":"k","content":"c","platforms":["bluesky"],"overrides":{"bluesky":{"content":"a","cont\\u0065nt":"b"}}}',
        ),
      ),
    ).toBe("INVALID_DOCUMENT");
  });

  it("rejects comments, trailing commas, and other non-JSON syntax", () => {
    for (const text of [
      '{"schemaVersion":1,/* no */"key":"k"}',
      '{"schemaVersion":1,"key":"k",}',
      "{'schemaVersion':1}",
    ]) {
      expect(codeOf(() => parseLocalPublishDocument(text))).toBe("INVALID_JSON");
    }
  });

  it("accepts one leading BOM from a string caller", () => {
    expect(parseLocalPublishDocument(`\uFEFF${documentText()}`).key).toBe(KEY);
  });

  it("rejects a second leading BOM from a string caller", () => {
    expect(
      codeOf(() => parseLocalPublishDocument(`\uFEFF\uFEFF${documentText()}`)),
    ).toBe("INVALID_DOCUMENT");
  });

  it("checks the 64 KiB source cap before the content rules", () => {
    const overhead = bytesOf(documentText({ content: "", overrides: undefined }))
      .byteLength;
    const fill = SOURCE_LIMIT - overhead;
    const atLimit = documentText({
      content: "a".repeat(fill),
      overrides: undefined,
    });
    const overLimit = documentText({
      content: "a".repeat(fill + 1),
      overrides: undefined,
    });

    expect(bytesOf(atLimit).byteLength).toBe(SOURCE_LIMIT);
    expect(bytesOf(overLimit).byteLength).toBe(SOURCE_LIMIT + 1);

    // The size guard is inclusive, so at the limit the content rule decides.
    expect(codeOf(() => parseLocalPublishDocument(atLimit))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(codeOf(() => parseLocalPublishDocument(overLimit))).toBe(
      "INPUT_TOO_LARGE",
    );
  });
});

describe("decodeLocalSource", () => {
  it("accepts exactly 64 KiB and rejects one byte more", () => {
    const overhead = bytesOf(documentText({ content: "", overrides: undefined }))
      .byteLength;
    const atLimit = bytesOf(
      documentText({
        content: "a".repeat(SOURCE_LIMIT - overhead),
        overrides: undefined,
      }),
    );

    expect(atLimit.byteLength).toBe(SOURCE_LIMIT);
    expect(decodeLocalSource(atLimit).text.length).toBe(SOURCE_LIMIT);

    const overLimit = new Uint8Array(SOURCE_LIMIT + 1).fill(0x20);

    expect(codeOf(() => decodeLocalSource(overLimit))).toBe("INPUT_TOO_LARGE");
  });

  it("strips one leading BOM but hashes the original bytes", () => {
    const text = documentText();
    const bytes = bytesOf(text);
    const withBom = concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), bytes);
    const decoded = decodeLocalSource(withBom);

    expect(decoded.text).toBe(text);
    expect(decoded.sourceSha256).toBe(sha256(withBom));
    expect(decoded.sourceSha256).not.toBe(sha256(bytes));
  });

  it("accepts exactly one leading BOM on the integrated read path", () => {
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf]),
      bytesOf(documentText()),
    );

    expect(parseLocalPublishDocument(decodeLocalSource(bytes).text).key).toBe(
      KEY,
    );
  });

  it("rejects a second leading BOM in the decoder", () => {
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
      bytesOf(documentText()),
    );

    expect(codeOf(() => decodeLocalSource(bytes))).toBe("INVALID_DOCUMENT");
  });

  it("refuses a second leading BOM on the integrated bytes to parse path", () => {
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
      bytesOf(documentText()),
    );

    expect(
      codeOf(() => parseLocalPublishDocument(decodeLocalSource(bytes).text)),
    ).toBe("INVALID_DOCUMENT");
  });

  it("rejects malformed UTF-8", () => {
    for (const bytes of [
      new Uint8Array([0x7b, 0xff, 0x7d]),
      new Uint8Array([0xed, 0xa0, 0x80]),
    ]) {
      expect(codeOf(() => decodeLocalSource(bytes))).toBe("INVALID_DOCUMENT");
    }
  });

  it("leaves a BOM that is not leading for the parser to reject", () => {
    const text =
      '{"schemaVersion":1,\uFEFF"key":"k","content":"c","platforms":["bluesky"]}';
    const decoded = decodeLocalSource(bytesOf(text));

    expect(decoded.text).toContain("\uFEFF");
    expect(codeOf(() => parseLocalPublishDocument(decoded.text))).toBe(
      "INVALID_JSON",
    );
  });
});

describe("parseLocalJson", () => {
  it("accepts nested JSON and decodes escapes", () => {
    expect(parseLocalJson('{"a":[1,true,null,"x"],"b":{"c":"\\u00e9"}}')).toEqual(
      { a: [1, true, null, "x"], b: { c: "\u00e9" } },
    );
  });

  it("rejects comments", () => {
    expect(codeOf(() => parseLocalJson('{"a":1/* no */}'))).toBe("INVALID_JSON");
    expect(codeOf(() => parseLocalJson('{"a":1} // trailing'))).toBe(
      "INVALID_JSON",
    );
  });

  it("rejects trailing commas", () => {
    expect(codeOf(() => parseLocalJson('{"a":1,}'))).toBe("INVALID_JSON");
    expect(codeOf(() => parseLocalJson("[1,]"))).toBe("INVALID_JSON");
  });

  it("rejects empty and non-JSON text", () => {
    for (const text of ["", "   ", "{'a':1}"]) {
      expect(codeOf(() => parseLocalJson(text))).toBe("INVALID_JSON");
    }
  });

  it("rejects repeated keys, including escaped equivalents", () => {
    for (const text of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"nested":{"x":1,"x":2}}',
      '[{"a":1,"a":2}]',
    ]) {
      expect(codeOf(() => parseLocalJson(text))).toBe("INVALID_DOCUMENT");
    }
  });

  it("rejects unpaired surrogates in text and in escapes", () => {
    expect(codeOf(() => parseLocalJson('{"a":"\ud800"}'))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(codeOf(() => parseLocalJson('{"a":"\\ud800"}'))).toBe(
      "INVALID_DOCUMENT",
    );
    expect(parseLocalJson('{"a":"\\ud83d\\ude00"}')).toEqual({ a: "\u{1F600}" });
  });

  it("rejects numbers outside the JSON range", () => {
    expect(codeOf(() => parseLocalJson("1e400"))).toBe("INVALID_JSON");
  });

  it("rejects nesting beyond the supported depth", () => {
    expect(codeOf(() => parseLocalJson("[".repeat(200) + "]".repeat(200)))).toBe(
      "INVALID_JSON",
    );
    expect(
      codeOf(() => parseLocalJson("[".repeat(20_000) + "]".repeat(20_000))),
    ).toBe("INVALID_JSON");
  });

  it("returns objects without a prototype", () => {
    const value = parseLocalJson('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect("polluted" in value).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("is stable across field order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("sorts integer-like keys as strings", () => {
    expect(canonicalJson({ 10: "ten", 9: "nine" })).toBe(
      '{"10":"ten","9":"nine"}',
    );
  });

  it("escapes strings the way JSON does", () => {
    expect(canonicalJson({ a: 'line\n"quote"' })).toBe(
      '{"a":"line\\n\\"quote\\""}',
    );
  });

  it("rejects values that are not JSON data", () => {
    for (const value of [
      undefined,
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: Number.NEGATIVE_INFINITY },
      { a: () => 1 },
    ]) {
      expect(codeOf(() => canonicalJson(value))).toBe("INVALID_DOCUMENT");
    }
  });
});

describe("canonicalDeliveryPayload", () => {
  const document = parseLocalPublishDocument(documentText());

  const options = {
    namespace: "default",
    payloadVersion: 1,
    payload: { text: "hello", facets: [] as readonly unknown[] },
  };

  function binding(overrides: Partial<Parameters<typeof canonicalDeliveryPayload>[1]> = {}) {
    return {
      provider: "bluesky" as const,
      targetId: "did:plc:alice",
      connectionId: `conn_${"a".repeat(32)}`,
      bindingRevision: 1,
      ...overrides,
    };
  }

  it("freezes the logical identity into a 64 hex delivery id", () => {
    const delivery = canonicalDeliveryPayload(document, binding(), options);

    expect(delivery.deliveryId).toMatch(/^[0-9a-f]{64}$/);
    expect(delivery.deliveryId).toBe(
      sha256(canonicalJson(["default", KEY, "bluesky", "did:plc:alice"])),
    );
  });

  it("matches a hand-derived id and payload hash", () => {
    // Independent vector: these are the canonical strings, and their digests
    // were computed with `node:crypto` and `hashlib.sha256` outside this code.
    expect(canonicalJson(["default", KEY, "bluesky", "did:plc:alice"])).toBe(
      '["default","syndroo-v060-announcement-001","bluesky","did:plc:alice"]',
    );
    expect(
      canonicalJson({
        payloadVersion: 1,
        payload: { text: "hello", facets: [] },
      }),
    ).toBe('{"payload":{"facets":[],"text":"hello"},"payloadVersion":1}');

    const delivery = canonicalDeliveryPayload(document, binding(), options);

    expect(delivery.deliveryId).toBe(
      "606fe171d678220787bcb8719e453ada07c9a85967f68339a075a474fdb10964",
    );
    expect(delivery.payloadHash).toBe(
      "fa906dd2b66c47a49fa44634eaadaed7dadcc8565fc3b5006402f0a70b28e531",
    );
  });

  it("ignores the binding revision but follows the target id", () => {
    const delivery = canonicalDeliveryPayload(document, binding(), options);

    expect(
      canonicalDeliveryPayload(
        document,
        binding({ bindingRevision: 9 }),
        options,
      ).deliveryId,
    ).toBe(delivery.deliveryId);

    expect(
      canonicalDeliveryPayload(
        document,
        binding({ targetId: "did:plc:bob" }),
        options,
      ).deliveryId,
    ).not.toBe(delivery.deliveryId);

    expect(
      canonicalDeliveryPayload(
        document,
        binding({ provider: "threads" }),
        options,
      ).deliveryId,
    ).not.toBe(delivery.deliveryId);
  });

  it("uses the override for that provider and the base content otherwise", () => {
    expect(
      canonicalDeliveryPayload(document, binding(), options).content,
    ).toBe("Syndroo：CLI-first，Agent-ready。");
    expect(
      canonicalDeliveryPayload(
        document,
        binding({ provider: "threads" }),
        options,
      ).content,
    ).toBe(document.content);
  });

  it("hashes the payload independently of key order", () => {
    const ordered = canonicalDeliveryPayload(document, binding(), {
      namespace: "default",
      payloadVersion: 1,
      payload: { text: "hi", lang: "en" },
    });
    const reordered = canonicalDeliveryPayload(document, binding(), {
      namespace: "default",
      payloadVersion: 1,
      payload: { lang: "en", text: "hi" },
    });
    const bumped = canonicalDeliveryPayload(document, binding(), {
      namespace: "default",
      payloadVersion: 2,
      payload: { text: "hi", lang: "en" },
    });

    expect(ordered.payloadHash).toBe(reordered.payloadHash);
    expect(ordered.payloadHash).toBe(
      sha256(
        canonicalJson({
          payloadVersion: 1,
          payload: { text: "hi", lang: "en" },
        }),
      ),
    );
    expect(bumped.payloadHash).not.toBe(ordered.payloadHash);
    expect(bumped.deliveryId).toBe(ordered.deliveryId);
  });
});

describe("legacy remote document parsing", () => {
  it("keeps accepting the remote shape and warning about unknown fields", () => {
    const parsed = parsePostDocument(
      JSON.stringify({
        content: "hi",
        platforms: ["x"],
        extra: 1,
        scheduledAt: "2030-01-01T00:00:00Z",
      }),
      "post.json",
    );

    expect(parsed.input.platforms).toEqual(["x"]);
    expect(parsed.input.scheduledAt).toBe("2030-01-01T00:00:00.000Z");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("extra");
  });

  it("still resolves repeated keys with JSON.parse semantics", () => {
    const parsed = parsePostDocument(
      '{"content":"first","content":"second","platforms":["x"]}',
      "post.json",
    );

    expect(parsed.input.content).toBe("second");
  });
});
