/**
 * L1 test preload (`node --import`), loaded only into CLI child processes.
 *
 * It is test-only instrumentation and is never part of the tarball or the
 * production bundle; no product flag can select it. What it does:
 *
 * - records every DNS lookup and returns a synthetic *public* address for the
 *   allowed provider hosts, so the accepted safe transport still performs its
 *   real address policy and pinning;
 * - for `node:https` requests, executes the production pinned lookup first and
 *   records the addresses it returned, then redirects only the socket to the
 *   loopback TLS fixture while keeping the original hostname, SNI, and
 *   `rejectUnauthorized: true` plus the synthetic test CA;
 * - for `tls.connect` (the `fetch`/undici path), redirects the socket to the
 *   fixture the same way;
 * - records and rejects any connection to a destination outside the fixture;
 * - records and rejects any child-process launch;
 * - counts state-file writes under the test root and secret-ish env reads.
 *
 * Limits (honest): this is destination substitution at the Node API layer, not
 * an OS firewall. The Linux `--network none` run and the macOS sandbox run
 * supply the independent OS-level coverage.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";

import { pathClassOf, type TraceEvent } from "./trace.js";

const require = createRequire(import.meta.url);

const tracePath = process.env["SYNDROO_L1_TRACE"];
const root = process.env["SYNDROO_L1_ROOT"] ?? "";
const fixture = process.env["SYNDROO_L1_FIXTURE"] ?? "";
const syntheticIp = process.env["SYNDROO_L1_SYNTHETIC_IP"] ?? "93.184.216.34";
const loopbackAny = (process.env["SYNDROO_L1_LOOPBACK_ANY"] ?? "")
  .split(",")
  .map(value => value.trim())
  .filter(value => value.length > 0);
const allowed = new Set(
  (process.env["SYNDROO_L1_ALLOW"] ?? "")
    .split(",")
    .map(host => host.trim())
    .filter(host => host.length > 0),
);

const realAppendFileSync = appendFileSync;

const traceFile = tracePath ?? "";

if (traceFile === "") {
  throw new Error("L1: SYNDROO_L1_TRACE is required");
}

/** Read the harness's own CA path before the env proxy is installed. */
const testCaValue = (() => {
  const caPath = process.env["SYNDROO_L1_CA"];

  if (caPath === undefined || caPath === "") {
    return undefined;
  }

  try {
    return readFileSync(caPath, "utf8");
  } catch {
    return undefined;
  }
})();

function trace(event: TraceEvent): void {
  // Fail closed: an unwritable trace must break the command, never be read as
  // "zero events".
  realAppendFileSync(traceFile, `${JSON.stringify(event)}\n`);
}

trace({ kind: "bootstrap" });

process.on("exit", () => {
  try {
    realAppendFileSync(traceFile, `${JSON.stringify({ kind: "end" })}\n`);
  } catch {
    process.exitCode = 99;
  }
});

function fixtureTarget(): { host: string; port: number } {
  const [host, port] = fixture.split(":");

  return { host: host ?? "127.0.0.1", port: Number(port ?? 0) };
}

function testCa(): string | undefined {
  return testCaValue;
}

function isAllowedHost(host: string | undefined): boolean {
  return host !== undefined && allowed.has(host);
}

function isFixtureHost(host: string | undefined): boolean {
  const target = fixtureTarget();
  return host === target.host;
}

/**
 * Exact fixture host+port. Any other loopback destination is rejected unless
 * the case explicitly opts in (`SYNDROO_L1_LOOPBACK_ANY`), which only the OAuth
 * callback cases use.
 */
function isFixtureDestination(host: string | undefined, port: number): boolean {
  const target = fixtureTarget();

  if (host === target.host && port === target.port) {
    return true;
  }

  const loopback = host === "127.0.0.1" || host === "localhost";

  return loopback && loopbackAny.includes(String(port));
}

type ConnectShape =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number; readonly lookup: boolean }
  | { readonly kind: "unix" }
  | null;

/** Parses the documented `net.Socket#connect` overloads; null = unsupported. */
function parseConnectArgs(args: readonly unknown[]): ConnectShape {
  const first = args[0];

  if (typeof first === "string" && !/^[0-9]+$/.test(first)) {
    return { kind: "unix" };
  }

  if (typeof first === "object" && first !== null) {
    const options = first as Record<string, unknown>;
    const path = options["path"];

    if (typeof path === "string" && path !== "") {
      return { kind: "unix" };
    }

    const port = Number(options["port"] ?? 0);
    const host = typeof options["host"] === "string" ? (options["host"] as string) : "localhost";

    return { kind: "tcp", host, port, lookup: typeof options["lookup"] === "function" };
  }

  const port = Number(first);

  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }

  const host = typeof args[1] === "string" ? (args[1] as string) : "localhost";
  const options = typeof args[1] === "object" && args[1] !== null ? (args[1] as Record<string, unknown>) : {};

  return { kind: "tcp", host, port, lookup: typeof options["lookup"] === "function" };
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

const dnsModule = require("node:dns") as typeof import("node:dns");
const dnsPromisesModule = require("node:dns/promises") as typeof import("node:dns/promises");

function lookupShim(
  hostname: string,
  options: unknown,
  callback: (...args: unknown[]) => void,
): void {
  trace({ kind: "dns", host: hostname });

  if (!isAllowedHost(hostname)) {
    const error = Object.assign(new Error("L1: unexpected DNS lookup"), { code: "ENOTFOUND" });

    if (typeof options === "function") {
      (options as (...args: unknown[]) => void)(error);
    } else {
      callback(error);
    }

    return;
  }

  const wantsAll =
    typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;

  if (wantsAll) {
    callback(null, [{ address: syntheticIp, family: 4 }]);
  } else {
    callback(null, syntheticIp, 4);
  }
}

dnsModule.lookup = lookupShim as unknown as typeof dnsModule.lookup;
dnsPromisesModule.lookup = (async (hostname: string, options?: unknown) => {
  trace({ kind: "dns", host: hostname });

  if (!isAllowedHost(hostname)) {
    throw Object.assign(new Error("L1: unexpected DNS lookup"), { code: "ENOTFOUND" });
  }

  if (typeof options === "object" && options !== null && (options as { all?: boolean }).all === true) {
    return [{ address: syntheticIp, family: 4 }];
  }

  return { address: syntheticIp, family: 4 };
}) as unknown as typeof dnsPromisesModule.lookup;

syncBuiltinESMExports();

/**
 * `dns.resolve*` paths are recorded and rejected: the accepted transport uses
 * `lookup`, so any resolve use is either a harness gap or an unexpected caller.
 * They are never silently allowed through.
 */
const RESOLVE_METHODS = [
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCname",
  "resolveMx",
  "resolveTxt",
  "resolveSrv",
  "resolvePtr",
  "resolveNs",
  "resolveSoa",
  "resolveNaptr",
  "resolveCaa",
] as const;

for (const name of RESOLVE_METHODS) {
  if (typeof (dnsModule as unknown as Record<string, unknown>)[name] !== "function") {
    continue;
  }

  (dnsModule as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    const hostname = typeof args[0] === "string" ? args[0] : "";
    const error = Object.assign(new Error("L1: dns.resolve is not covered; use lookup"), {
      code: "ENOTFOUND",
    });
    const callback = args[args.length - 1];

    trace({ kind: "dns", host: hostname });
    trace({ kind: "reject", what: "dns-resolve", detail: name });

    if (typeof callback === "function") {
      (callback as (value: unknown) => void)(error);
      return;
    }

    throw error;
  };

  if (typeof (dnsPromisesModule as unknown as Record<string, unknown>)[name] === "function") {
    (dnsPromisesModule as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      trace({ kind: "dns", host: typeof args[0] === "string" ? (args[0] as string) : "" });
      trace({ kind: "reject", what: "dns-resolve", detail: name });
      throw Object.assign(new Error("L1: dns.resolve is not covered; use lookup"), {
        code: "ENOTFOUND",
      });
    };
  }
}

syncBuiltinESMExports();

// ---------------------------------------------------------------------------
// TLS / HTTPS
// ---------------------------------------------------------------------------

const tlsModule = require("node:tls") as typeof import("node:tls");
const httpsModule = require("node:https") as typeof import("node:https");
const netModule = require("node:net") as typeof import("node:net");

function withTestCa(ca: unknown): unknown {
  const test = testCa();

  if (test === undefined) {
    return ca;
  }

  if (ca === undefined) {
    return test;
  }

  return [...(Array.isArray(ca) ? ca : [ca]), test];
}

const originalTlsConnect = tlsModule.connect;

/** Parses the documented `tls.connect` overloads; null = unsupported shape. */
function parseTlsArgs(args: readonly unknown[]): Record<string, unknown> | null {
  const first = args[0];

  if (typeof first === "object" && first !== null) {
    return { ...(first as Record<string, unknown>) };
  }

  if (typeof first === "number") {
    const extra =
      typeof args[1] === "object" && args[1] !== null
        ? { ...(args[1] as Record<string, unknown>) }
        : {};
    const host = typeof args[1] === "string" ? (args[1] as string) : "localhost";

    return { ...extra, port: first, host };
  }

  return null;
}

tlsModule.connect = ((...args: unknown[]) => {
  const options = parseTlsArgs(args);

  if (options === null) {
    trace({ kind: "reject", what: "tls", detail: "unsupported-shape" });
    throw new Error("L1: unsupported TLS connect shape");
  }

  const target = fixtureTarget();
  const host = typeof options["host"] === "string" ? (options["host"] as string) : undefined;
  const port = Number(options["port"] ?? 443);
  const servername =
    typeof options["servername"] === "string" ? (options["servername"] as string) : host ?? null;

  if (host !== undefined && port === target.port && (host === target.host || isAllowedHost(host))) {
    // Already redirected by the `node:https` shim: keep the original hostname
    // and SNI, and make sure the synthetic CA is trusted.
    trace({ kind: "tls", host, servername });
    options["ca"] = withTestCa(options["ca"]);
    options["rejectUnauthorized"] = true;

    return (originalTlsConnect as (...inner: unknown[]) => unknown)(options, ...args.slice(1));
  }

  if (host !== undefined && isAllowedHost(host) && port === 443) {
    trace({ kind: "tls", host, servername });
    options["host"] = target.host;
    options["port"] = target.port;
    options["servername"] = options["servername"] ?? host;
    options["ca"] = withTestCa(options["ca"]);
    options["rejectUnauthorized"] = true;

    return (originalTlsConnect as (...inner: unknown[]) => unknown)(options, ...args.slice(1));
  }

  if (host !== undefined && isFixtureDestination(host, port)) {
    trace({ kind: "tls", host, servername });

    return (originalTlsConnect as (...inner: unknown[]) => unknown)(options, ...args.slice(1));
  }

  trace({ kind: "reject", what: "tls", detail: `${host ?? "?"}:${port}` });
  throw new Error("L1: unexpected TLS destination");
}) as unknown as typeof tlsModule.connect;

const originalHttpsRequest = httpsModule.request;

httpsModule.request = ((...args: unknown[]) => {
  const first = args[0];
  let options: Record<string, unknown>;
  let rest: readonly unknown[];

  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(typeof first === "string" ? first : first.href);
    const extra =
      typeof args[1] === "object" && args[1] !== null
        ? (args[1] as Record<string, unknown>)
        : {};

    options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      ...extra,
    };
    rest = typeof args[1] === "object" && args[1] !== null && typeof args[2] === "function"
      ? [args[2]]
      : args.slice(1);
  } else {
    options = { ...((first as Record<string, unknown>) ?? {}) };
    rest = args.slice(1);
  }
  const host =
    typeof options["hostname"] === "string"
      ? (options["hostname"] as string)
      : typeof options["host"] === "string"
        ? (options["host"] as string)
        : undefined;
  const port = Number(options["port"] ?? 443);
  const method = typeof options["method"] === "string" ? (options["method"] as string) : "GET";
  const path = typeof options["path"] === "string" ? (options["path"] as string) : "/";

  trace({
    kind: "http",
    host: host ?? "",
    port,
    method,
    pathClass: pathClassOf(path.split("?")[0] ?? "/"),
  });

  if (!isAllowedHost(host)) {
    trace({ kind: "reject", what: "https", detail: host ?? "" });
    throw new Error("L1: unexpected HTTPS destination");
  }

  const target = fixtureTarget();
  const productionLookup = options["lookup"];

  options["port"] = target.port;
  options["servername"] = options["servername"] ?? host;
  options["ca"] = withTestCa(options["ca"]);
  options["rejectUnauthorized"] = true;
  options["lookup"] = (hostname: string, lookupOptions: unknown, callback: (...inner: unknown[]) => void) => {
    if (typeof productionLookup !== "function") {
      trace({ kind: "reject", what: "pinned-lookup", detail: "missing" });
      throw new Error("L1: allowed HTTPS destination without a pinned lookup");
    }

    (productionLookup as (...inner: unknown[]) => void)(hostname, lookupOptions, (error: unknown, address: unknown) => {
      if (error !== null && error !== undefined) {
        callback(error);
        return;
      }

      const addresses = Array.isArray(address)
        ? (address as readonly { address: string }[]).map(entry => entry.address)
        : [String(address)];

      trace({ kind: "pinned-lookup", host: hostname, addresses });

      const wantsAll =
        typeof lookupOptions === "object" &&
        lookupOptions !== null &&
        (lookupOptions as { all?: boolean }).all === true;

      if (wantsAll) {
        callback(null, [{ address: target.host, family: 4 }]);
      } else {
        callback(null, target.host, 4);
      }
    });
  };

  return (originalHttpsRequest as (...inner: unknown[]) => unknown)(options, ...rest);
}) as unknown as typeof httpsModule.request;

const originalSocketConnect = netModule.Socket.prototype.connect;

netModule.Socket.prototype.connect = function (this: import("node:net").Socket, ...args: unknown[]) {
  const shape = parseConnectArgs(args);

  if (shape === null) {
    trace({ kind: "reject", what: "connect", detail: "unsupported-shape" });
    throw new Error("L1: unsupported socket connect shape");
  }

  if (shape.kind === "unix") {
    trace({ kind: "connect", host: "<unix>", port: 0, allowed: true });
    return (originalSocketConnect as (...inner: unknown[]) => unknown).apply(this, args);
  }

  const target = fixtureTarget();
  // An allowed provider hostname is only acceptable when the caller supplied a
  // lookup: the `node:https` shim's lookup is what moves the socket to the
  // fixture while keeping the original name for SNI and verification.
  const allowed =
    (shape.host === target.host && shape.port === target.port) ||
    isFixtureDestination(shape.host, shape.port) ||
    (isAllowedHost(shape.host) && shape.lookup);

  trace({ kind: "connect", host: shape.host, port: shape.port, allowed });

  if (!allowed) {
    trace({ kind: "reject", what: "connect", detail: `${shape.host}:${shape.port}` });
    throw new Error("L1: unexpected socket destination");
  }

  return (originalSocketConnect as (...inner: unknown[]) => unknown).apply(this, args);
} as typeof netModule.Socket.prototype.connect;

syncBuiltinESMExports();

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  try {
    const parsed = new URL(url);
    trace({
      kind: "http",
      host: parsed.hostname,
      port: Number(parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : parsed.port),
      method: (init?.method ?? "GET").toUpperCase(),
      pathClass: pathClassOf(parsed.pathname),
    });

    if (!isAllowedHost(parsed.hostname)) {
      trace({ kind: "reject", what: "fetch", detail: parsed.hostname });
      throw new Error("L1: unexpected fetch destination");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("L1:")) {
      throw error;
    }
  }

  return originalFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

const childProcessModule = require("node:child_process") as typeof import("node:child_process");

for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"] as const) {
  const original = childProcessModule[name];

  (childProcessModule as unknown as Record<string, unknown>)[name] = ((...args: unknown[]) => {
    const command = typeof args[0] === "string" ? args[0] : "";
    trace({ kind: "child", command: basename(command) });
    throw new Error("L1: unexpected child process launch");
  }) as unknown as typeof original;
}

syncBuiltinESMExports();

// ---------------------------------------------------------------------------
// State-file writes
// ---------------------------------------------------------------------------

const fsModule = require("node:fs") as typeof import("node:fs");
const fsPromisesModule = require("node:fs/promises") as typeof import("node:fs/promises");

function underRoot(path: unknown): string | null {
  return root !== "" && typeof path === "string" && path.startsWith(root) ? path : null;
}

function trackWrite(path: unknown): void {
  const tracked = underRoot(path);

  if (tracked !== null) {
    trace({ kind: "fswrite", path: tracked });
  }
}

function trackRead(path: unknown): void {
  const tracked = underRoot(path);

  if (tracked !== null) {
    trace({ kind: "fsread", path: tracked });
  }
}

/** `open` flags decide read vs write; numeric and string flags are both parsed. */
function flagsAreWrite(flags: unknown): boolean {
  if (typeof flags === "number") {
    const constants = fsModule.constants;

    return (
      (flags &
        (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)) !==
      0
    );
  }

  if (typeof flags === "string") {
    return flags !== "r" && flags !== "rs" && flags !== "sr";
  }

  return false;
}

for (const name of [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "renameSync",
  "unlinkSync",
  "rmSync",
] as const) {
  const original = fsModule[name];

  (fsModule as unknown as Record<string, unknown>)[name] = ((...args: unknown[]) => {
    trackWrite(args[0]);
    return (original as (...inner: unknown[]) => unknown)(...args);
  }) as unknown as typeof original;
}

for (const name of ["readFileSync", "createReadStream"] as const) {
  const original = fsModule[name];

  (fsModule as unknown as Record<string, unknown>)[name] = ((...args: unknown[]) => {
    trackRead(args[0]);
    return (original as (...inner: unknown[]) => unknown)(...args);
  }) as unknown as typeof original;
}

{
  const originalOpenSync = fsModule.openSync;

  fsModule.openSync = ((...args: unknown[]) => {
    if (flagsAreWrite(args[1])) {
      trackWrite(args[0]);
    } else {
      trackRead(args[0]);
    }

    return (originalOpenSync as (...inner: unknown[]) => unknown)(...args);
  }) as typeof fsModule.openSync;
}

for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm"] as const) {
  const original = fsPromisesModule[name];

  (fsPromisesModule as unknown as Record<string, unknown>)[name] = ((...args: unknown[]) => {
    trackWrite(args[0]);
    return (original as (...inner: unknown[]) => unknown)(...args);
  }) as unknown as typeof original;
}

{
  const originalReadFile = fsPromisesModule.readFile;

  fsPromisesModule.readFile = ((...args: unknown[]) => {
    trackRead(args[0]);
    return (originalReadFile as (...inner: unknown[]) => unknown)(...args);
  }) as typeof fsPromisesModule.readFile;
}

{
  const originalOpen = fsPromisesModule.open;

  fsPromisesModule.open = ((...args: unknown[]) => {
    if (flagsAreWrite(args[1])) {
      trackWrite(args[0]);
    } else {
      trackRead(args[0]);
    }

    return (originalOpen as (...inner: unknown[]) => unknown)(...args);
  }) as typeof fsPromisesModule.open;
}

syncBuiltinESMExports();

// ---------------------------------------------------------------------------
// Secret-ish environment reads
// ---------------------------------------------------------------------------

/** Exact credential env names; `SYNDROO_*` configuration is recorded separately. */
const CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  "SYNDROO_API_KEY",
  "BLUESKY_IDENTIFIER",
  "BLUESKY_APP_PASSWORD",
  "THREADS_ACCESS_TOKEN",
  "LINKEDIN_ACCESS_TOKEN",
  "LINKEDIN_AUTHOR",
  "LINKEDIN_API_VERSION",
  "MASTODON_ACCESS_TOKEN",
  "MASTODON_INSTANCE",
  "DEVTO_API_KEY",
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
  "TUMBLR_CONSUMER_KEY",
  "TUMBLR_CONSUMER_SECRET",
  "TUMBLR_TOKEN",
  "TUMBLR_TOKEN_SECRET",
]);
const CONFIG_ENV = /^SYNDROO_/;
const realEnv = process.env;
const envProxy = new Proxy(realEnv, {
  get(target, property, receiver) {
    if (typeof property === "string" && CREDENTIAL_ENV.has(property)) {
      trace({ kind: "env", name: property, credential: true });
    } else if (typeof property === "string" && CONFIG_ENV.test(property)) {
      trace({ kind: "env", name: property, credential: false });
    }

    return Reflect.get(target, property, receiver);
  },
  set(target, property, value) {
    return Reflect.set(target, property, value);
  },
  has(target, property) {
    return Reflect.has(target, property);
  },
  ownKeys(target) {
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, property) {
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
});

Object.defineProperty(process, "env", { value: envProxy, configurable: true });
