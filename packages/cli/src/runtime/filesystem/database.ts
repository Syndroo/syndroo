import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { parseStrictResponseJson } from "@syndroo/core";
import type * as T from "@syndroo/core";

import {
  CURRENT_FILE_NAME,
  createOwnedFile,
  decodeUtf8,
  ensureOwnedDirectory,
  ensureStateRoot,
  listDirectoryNames,
  readOwnedFile,
  removeOwnedDirectory,
  removeTemporaryName,
  replaceOwnedFile,
  requireOwnedDirectory,
  resolveStateRootPath,
  syncDirectory,
} from "./atomic.js";
import { fail, isFailure } from "./errors.js";
import { acquireWriteLock, releaseWriteLock, withProcessQueue } from "./lock.js";
import {
  RUNTIME_FORMAT,
  generationDirectory,
  generationRecordsDirectory,
  generationName,
  journalPath,
  layoutOf,
  recordsDirectory,
  tombstonePath,
} from "./paths.js";

/**
 * The local generation store.
 *
 * Business state is a chain of write-once generation directories:
 *
 * ```
 * <root>/format.json                     the only accepted format marker
 * <root>/CURRENT                         `gen-000123`; the published pointer
 * <root>/generations/gen-000123/         immutably created, never edited
 *     journal.json                       commit marker: generation, base, action,
 *                                        time and every live record's location
 *     records/<kind>/<id>.json           immutable record bytes
 * <root>/lock/                           exclusive writer lock
 * <root>/secrets/…                       independent credential blobs
 * ```
 *
 * A business action reads the generation named by `CURRENT`, mutates an
 * in-memory copy, writes only the records whose bytes changed into the next
 * generation directory, writes that directory's journal, fsyncs files and
 * directories, and finally replaces `CURRENT` atomically. Readers see only
 * `CURRENT` and the generations its journal references, so a crash anywhere
 * before the pointer replacement leaves the previous generation authoritative
 * and a crash after it leaves the new one authoritative. Unreferenced
 * generation directories are garbage and are removed only at write entry.
 *
 * Damaged or missing evidence (a `CURRENT` naming a generation without a valid
 * journal, a record the journal references that cannot be read, a foreign
 * format marker, generations without a pointer) fails closed with
 * `STATE_RECOVERY_REQUIRED`. Reads never repair anything.
 */

export type RecordKind =
  | "meta"
  | "connection"
  | "session"
  | "operation"
  | "intent"
  | "approval"
  | "request"
  | "step";

const RECORD_KINDS: readonly RecordKind[] = [
  "meta",
  "connection",
  "session",
  "operation",
  "intent",
  "approval",
  "request",
  "step",
];

export type RequestEntry = {
  digest: string;
  operationId?: string;
  sessionId?: string;
  result?: T.ConnectResult;
  error?: T.SafeError;
};

export type StepEntry = {
  digest: string;
  claim?: T.StepClaim;
  result?: T.ConnectResult;
  error?: T.SafeError;
};

export type ApprovalEntry = {
  work: T.WorkRef;
  admitted: boolean;
  principalId: string;
};

export type MetaRecord = {
  sequence: number;
  fence: number;
  /** Integrity key for list cursors. Generated once, then never rotated. */
  cursorKey: string;
  /**
   * Creation sequence per operation id.
   *
   * Cursor paging and notification order use this number, not `createdAt`, so a
   * clock that moves backwards cannot reorder or re-expose operations.
   */
  creation: Record<string, number>;
};

export type Data = {
  meta: MetaRecord;
  connections: Map<string, T.ConnectionRecord>;
  sessions: Map<string, T.ConnectSession>;
  operations: Map<string, T.OperationRecord>;
  intents: Map<string, T.FrozenIntent>;
  approvals: Map<string, ApprovalEntry>;
  requests: Map<string, RequestEntry>;
  steps: Map<string, StepEntry>;
};

export function emptyData(): Data {
  return {
    meta: { sequence: 0, fence: 0, cursorKey: "", creation: {} },
    connections: new Map(),
    sessions: new Map(),
    operations: new Map(),
    intents: new Map(),
    approvals: new Map(),
    requests: new Map(),
    steps: new Map(),
  };
}

export type JournalEntry = {
  kind: RecordKind;
  id: string;
  generation: number;
};

export type Journal = {
  format: string;
  generation: number;
  base: number | null;
  action: string;
  committedAt: string;
  records: readonly JournalEntry[];
};

type Snapshot = {
  data: Data;
  generation: number;
  records: Map<string, JournalEntry>;
  stored: Map<string, string>;
};

/**
 * Test-only crash points. They are injected through the runtime options and
 * have no environment variable, configuration key or command-line switch.
 */
export type FaultPoint =
  | "after-records-fsync"
  | "after-journal-fsync"
  | "before-current-replace"
  | "after-current-replace"
  | "before-lock-release";

export type FaultInjector = (point: FaultPoint) => void | Promise<void>;

export type WriteSession = {
  readonly root: string;
  readonly data: Data;
  /** Fails when a staged secret reference has already been fenced. */
  assertNotRetired(ref: string): Promise<void>;
};

const keyOf = (kind: RecordKind, id: string): string => `${kind}\u0000${id}`;

/**
 * Record file names stay readable for the ids this runtime generates, and fall
 * back to a digest for anything longer or exotic so a name can never exceed a
 * filesystem limit or introduce a separator. The record file repeats its kind
 * and id, so a name is never the only evidence of what a file holds.
 */
function recordName(id: string): string {
  if (/^[A-Za-z0-9._-]{1,80}$/.test(id)) {
    return `${id}.json`;
  }

  return `x-${createHash("sha256").update(id, "utf8").digest("hex")}.json`;
}

function serializeRecord(kind: RecordKind, id: string, value: unknown): string {
  return JSON.stringify({ kind, id, value });
}

function* recordsOf(data: Data): Generator<{
  kind: RecordKind;
  id: string;
  value: unknown;
}> {
  yield { kind: "meta", id: "state", value: data.meta };

  for (const [id, value] of data.connections) {
    yield { kind: "connection", id, value };
  }

  for (const [id, value] of data.sessions) {
    yield { kind: "session", id, value };
  }

  for (const [id, value] of data.operations) {
    yield { kind: "operation", id, value };
  }

  for (const [id, value] of data.intents) {
    yield { kind: "intent", id, value };
  }

  for (const [id, value] of data.approvals) {
    yield { kind: "approval", id, value };
  }

  for (const [id, value] of data.requests) {
    yield { kind: "request", id, value };
  }

  for (const [id, value] of data.steps) {
    yield { kind: "step", id, value };
  }
}

function parseGeneration(text: string): number {
  const match = /^gen-([0-9]{6,})$/.exec(text.trim());
  const value = match ? Number(match[1]) : Number.NaN;

  if (!Number.isSafeInteger(value) || value < 1) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  return value;
}

function parseJson(text: string): unknown {
  try {
    // The strict parser is the guard (duplicate keys, depth, UTF-8, numbers);
    // `JSON.parse` then materialises ordinary objects for callers instead of
    // the parser's null-prototype objects.
    parseStrictResponseJson(text);

    return JSON.parse(text);
  } catch (error) {
    if (isFailure(error) && error.code !== "INVALID_INPUT") {
      throw error;
    }

    return fail("STATE_RECOVERY_REQUIRED");
  }
}

async function readFormatMarker(root: string): Promise<string | null> {
  const bytes = await readOwnedFile(layoutOf(root).format);

  if (bytes === null) {
    return null;
  }

  const value = parseJson(decodeUtf8(bytes));

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { format?: unknown }).format !== RUNTIME_FORMAT
  ) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  return RUNTIME_FORMAT;
}

async function readCurrent(root: string): Promise<number | null> {
  const bytes = await readOwnedFile(layoutOf(root).current);

  return bytes === null ? null : parseGeneration(decodeUtf8(bytes));
}

async function readJournal(root: string, generation: number): Promise<Journal> {
  const bytes = await readOwnedFile(journalPath(root, generation));

  if (bytes === null) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  const value = parseJson(decodeUtf8(bytes));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  const record = value as Record<string, unknown>;

  if (
    record["format"] !== RUNTIME_FORMAT ||
    record["generation"] !== generation ||
    typeof record["action"] !== "string" ||
    typeof record["committedAt"] !== "string" ||
    !Array.isArray(record["records"])
  ) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  const base = record["base"];

  if (
    base !== null &&
    (typeof base !== "number" || !Number.isSafeInteger(base) || base < 1)
  ) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  const records: JournalEntry[] = [];

  for (const item of record["records"] as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail("STATE_RECOVERY_REQUIRED");
    }

    const entry = item as Record<string, unknown>;
    const kind = entry["kind"];
    const id = entry["id"];
    const entryGeneration = entry["generation"];

    if (
      typeof kind !== "string" ||
      !RECORD_KINDS.includes(kind as RecordKind) ||
      typeof id !== "string" ||
      id.length === 0 ||
      typeof entryGeneration !== "number" ||
      !Number.isSafeInteger(entryGeneration) ||
      entryGeneration < 1 ||
      entryGeneration > generation
    ) {
      fail("STATE_RECOVERY_REQUIRED");
    }

    records.push({ kind: kind as RecordKind, id, generation: entryGeneration });
  }

  const action = record["action"];
  const committedAt = record["committedAt"];

  return {
    format: RUNTIME_FORMAT,
    generation,
    base,
    action,
    committedAt,
    records,
  };
}

async function readRecord(
  root: string,
  entry: JournalEntry,
): Promise<string> {
  const directory = recordsDirectory(root, entry.generation, entry.kind);
  const bytes = await readOwnedFile(
    path.join(directory, recordName(entry.id)),
  );

  if (bytes === null) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  const text = decodeUtf8(bytes);
  const value = parseJson(text);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  const record = value as Record<string, unknown>;

  if (
    record["kind"] !== entry.kind ||
    record["id"] !== entry.id ||
    !("value" in record)
  ) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  return text;
}

function assign(data: Data, entry: JournalEntry, value: unknown): void {
  switch (entry.kind) {
    case "meta": {
      if (entry.id !== "state") {
        fail("STATE_RECOVERY_REQUIRED");
      }

      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("STATE_RECOVERY_REQUIRED");
      }

      const meta = value as Record<string, unknown>;
      const creation = meta["creation"];

      if (
        typeof meta["sequence"] !== "number" ||
        !Number.isSafeInteger(meta["sequence"]) ||
        meta["sequence"] < 0 ||
        typeof meta["fence"] !== "number" ||
        !Number.isSafeInteger(meta["fence"]) ||
        meta["fence"] < 0 ||
        typeof meta["cursorKey"] !== "string" ||
        typeof creation !== "object" ||
        creation === null ||
        Array.isArray(creation)
      ) {
        fail("STATE_RECOVERY_REQUIRED");
      }

      for (const [id, sequence] of Object.entries(creation)) {
        if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
          fail("STATE_RECOVERY_REQUIRED");
        }

        void id;
      }

      data.meta = {
        sequence: meta["sequence"],
        fence: meta["fence"],
        cursorKey: meta["cursorKey"],
        creation: { ...(creation as Record<string, number>) },
      };

      return;
    }
    case "connection":
      data.connections.set(entry.id, value as T.ConnectionRecord);

      return;
    case "session":
      data.sessions.set(entry.id, value as T.ConnectSession);

      return;
    case "operation":
      data.operations.set(entry.id, value as T.OperationRecord);

      return;
    case "intent":
      data.intents.set(entry.id, value as T.FrozenIntent);

      return;
    case "approval":
      data.approvals.set(entry.id, value as ApprovalEntry);

      return;
    case "request":
      data.requests.set(entry.id, value as RequestEntry);

      return;
    case "step":
      data.steps.set(entry.id, value as StepEntry);

      return;
    default:
      fail("STATE_RECOVERY_REQUIRED");
  }
}

export class Database {
  #resolved: string | null = null;

  constructor(
    readonly root: string,
    readonly fault: FaultInjector | undefined,
    readonly now: () => string,
  ) {}

  /** The resolved root when it exists, or `null` for a state-free runtime. */
  async resolveForRead(): Promise<string | null> {
    if (this.#resolved !== null) {
      return this.#resolved;
    }

    const { resolved, missing } = await resolveStateRootPath(this.root);

    if (missing.length > 0) {
      return null;
    }

    await requireOwnedDirectory(resolved);
    this.#resolved = resolved;

    return resolved;
  }

  async #resolveForWrite(): Promise<string> {
    if (this.#resolved === null) {
      this.#resolved = await ensureStateRoot(this.root);
    }

    return this.#resolved;
  }

  async read<T>(
    work: (data: Data, root: string | null) => T | Promise<T>,
  ): Promise<T> {
    const root = await this.resolveForRead();

    if (root === null) {
      return await work(emptyData(), null);
    }

    // A read validates the marker but never creates or repairs it: a root whose
    // marker names another format is somebody else's state, and a published
    // generation without a marker is damaged evidence.
    const marker = await readFormatMarker(root);

    if (marker === null && (await readCurrent(root)) !== null) {
      fail("STATE_RECOVERY_REQUIRED");
    }

    const snapshot = await this.#loadStable(root);

    return await work(snapshot.data, root);
  }

  async write<T>(
    action: string,
    work: (session: WriteSession) => T | Promise<T>,
  ): Promise<T> {
    return withProcessQueue(path.resolve(this.root), async () => {
      const root = await this.#resolveForWrite();
      const held = await acquireWriteLock(root, this.now());

      try {
        await this.#prepareLayout(root);

        const snapshot = await this.#load(root);

        if (snapshot.data.meta.cursorKey === "") {
          snapshot.data.meta.cursorKey = randomBytes(32).toString("base64url");
        }

        const value = await work({
          root,
          data: snapshot.data,
          assertNotRetired: async ref => {
            if ((await readTombstone(root, ref)) !== null) {
              fail("DURABILITY_ERROR");
            }
          },
        });

        await this.#publish(root, snapshot, snapshot.data, action);
        await this.fault?.("before-lock-release");

        return value;
      } finally {
        await releaseWriteLock(root, held);
      }
    });
  }

  /**
   * Write-entry preparation: the format marker, the fixed child directories and
   * garbage recovery. Nothing here runs on a read path.
   */
  async #prepareLayout(root: string): Promise<void> {
    await requireOwnedDirectory(root);

    if ((await readFormatMarker(root)) === null) {
      await createOwnedFile(
        root,
        path.basename(layoutOf(root).format),
        Buffer.from(`${JSON.stringify({ format: RUNTIME_FORMAT })}\n`, "utf8"),
      );
    }

    await ensureOwnedDirectory(layoutOf(root).generations);
    await ensureOwnedDirectory(layoutOf(root).secrets);
    await ensureOwnedDirectory(layoutOf(root).blobs);
    await ensureOwnedDirectory(layoutOf(root).tombstones);

    // A new root is published empty before the first business action. From then
    // on `CURRENT` always names a generation, so a crashed commit can always
    // fall back to the previous published one.
    if (
      (await readCurrent(root)) === null &&
      (await listDirectoryNames(layoutOf(root).generations)).length === 0
    ) {
      const initial = emptyData();

      initial.meta.cursorKey = randomBytes(32).toString("base64url");

      await this.#publish(
        root,
        {
          data: emptyData(),
          generation: 0,
          records: new Map(),
          stored: new Map(),
        },
        initial,
        "initialize",
      );
    }

    await this.#recover(root);
  }

  /**
   * Removes only provable garbage: generation directories that `CURRENT` and
   * its journal do not reference, plus temporary names this runtime writes.
   *
   * Anything else in the tree is damaged evidence and fails closed. In
   * particular, generation directories with no `CURRENT` pointer are never
   * deleted, because a missing pointer cannot be told apart from deleted state.
   */
  async #recover(root: string): Promise<void> {
    for (const name of await listDirectoryNames(root)) {
      if (name.startsWith(".tmp-")) {
        await removeTemporaryName(path.join(root, name)).catch(() => undefined);
      }
    }

    const generation = await readCurrent(root);
    const names = await listDirectoryNames(layoutOf(root).generations);

    if (generation === null) {
      // No pointer: a generation directory without a journal was never
      // published and is provably garbage, while one that does carry a journal
      // cannot be told apart from deleted state and fails closed.
      for (const name of names) {
        if (name.startsWith(".tmp-")) {
          await removeTemporaryName(
            path.join(layoutOf(root).generations, name),
          ).catch(() => undefined);

          continue;
        }

        const match = /^gen-([0-9]{6,})$/.exec(name);
        const value = match ? Number(match[1]) : Number.NaN;

        if (!Number.isSafeInteger(value) || value < 1) {
          fail("STATE_RECOVERY_REQUIRED");
        }

        const journal = await readOwnedFile(journalPath(root, value));

        if (journal === null) {
          await removeOwnedDirectory(
            path.join(layoutOf(root).generations, name),
          );

          continue;
        }

        fail("STATE_RECOVERY_REQUIRED");
      }

      return;
    }

    const journal = await readJournal(root, generation);
    const referenced = new Set<number>([generation]);

    for (const entry of journal.records) {
      referenced.add(entry.generation);
    }

    for (const name of names) {
      if (name.startsWith(".tmp-")) {
        await removeTemporaryName(
          path.join(layoutOf(root).generations, name),
        ).catch(() => undefined);

        continue;
      }

      const match = /^gen-([0-9]{6,})$/.exec(name);
      const value = match ? Number(match[1]) : Number.NaN;

      if (!Number.isSafeInteger(value) || value < 1) {
        fail("STATE_RECOVERY_REQUIRED");
      }

      if (!referenced.has(value)) {
        await removeOwnedDirectory(
          path.join(layoutOf(root).generations, name),
        );
      }
    }
  }

  async #load(root: string): Promise<Snapshot> {
    const data = emptyData();
    const generation = await readCurrent(root);

    if (generation === null) {
      if ((await listDirectoryNames(layoutOf(root).generations)).length > 0) {
        fail("STATE_RECOVERY_REQUIRED");
      }

      return { data, generation: 0, records: new Map(), stored: new Map() };
    }

    const journal = await readJournal(root, generation);
    const records = new Map<string, JournalEntry>();
    const stored = new Map<string, string>();

    for (const entry of journal.records) {
      const text = await readRecord(root, entry);

      stored.set(keyOf(entry.kind, entry.id), text);
      records.set(keyOf(entry.kind, entry.id), entry);
      assign(data, entry, JSON.parse(text)["value"]);
    }

    return { data, generation, records, stored };
  }

  /**
   * Loads one committed generation, retrying once.
   *
   * A reader captures `CURRENT` and then reads the records its journal names,
   * without the writer lock. A concurrent commit may reclaim a generation the
   * captured journal still named, which surfaces as a missing record. That is a
   * lost race, not damage, so the read is retried against the pointer the writer
   * just published. Genuine damage fails both attempts and still reports
   * `STATE_RECOVERY_REQUIRED`.
   */
  async #loadStable(root: string): Promise<Snapshot> {
    try {
      return await this.#load(root);
    } catch (error) {
      if (isFailure(error) && error.code === "STATE_RECOVERY_REQUIRED") {
        return await this.#load(root);
      }

      throw error;
    }
  }

  /**
   * Writes only the records whose bytes changed, then commits the generation.
   *
   * The commit marker is the new generation's journal; the publication point is
   * the atomic replacement of `CURRENT`.
   */
  async #publish(
    root: string,
    snapshot: Snapshot,
    data: Data,
    action: string,
  ): Promise<void> {
    const generation = snapshot.generation + 1;
    const index: JournalEntry[] = [];
    const changed: { kind: RecordKind; id: string; text: string }[] = [];

    for (const item of recordsOf(data)) {
      const key = keyOf(item.kind, item.id);
      const text = serializeRecord(item.kind, item.id, item.value);
      const previous = snapshot.records.get(key);

      if (previous !== undefined && snapshot.stored.get(key) === text) {
        index.push(previous);

        continue;
      }

      changed.push({ kind: item.kind, id: item.id, text });
      index.push({ kind: item.kind, id: item.id, generation });
    }

    if (changed.length === 0) {
      // Nothing changed: a read-only action must not publish an empty
      // generation, and the previous one stays authoritative.
      return;
    }

    index.sort((left, right) =>
      left.kind === right.kind
        ? left.id.localeCompare(right.id)
        : left.kind.localeCompare(right.kind),
    );

    const directory = generationDirectory(root, generation);

    await ensureOwnedDirectory(directory);
    await ensureOwnedDirectory(generationRecordsDirectory(root, generation));

    const touched = new Set<string>();

    for (const item of changed) {
      const kindDirectory = recordsDirectory(root, generation, item.kind);

      await ensureOwnedDirectory(kindDirectory);
      await createOwnedFile(
        kindDirectory,
        recordName(item.id),
        Buffer.from(item.text, "utf8"),
      );
      touched.add(kindDirectory);
    }

    for (const kindDirectory of touched) {
      await syncDirectory(kindDirectory);
    }

    await syncDirectory(directory);
    await this.fault?.("after-records-fsync");

    const journal: Journal = {
      format: RUNTIME_FORMAT,
      generation,
      base: snapshot.generation === 0 ? null : snapshot.generation,
      action,
      committedAt: this.now(),
      records: index,
    };

    await createOwnedFile(
      directory,
      path.basename(journalPath(root, generation)),
      Buffer.from(JSON.stringify(journal), "utf8"),
    );
    await syncDirectory(directory);
    await syncDirectory(layoutOf(root).generations);
    await this.fault?.("after-journal-fsync");

    await this.fault?.("before-current-replace");
    await replaceOwnedFile(
      root,
      CURRENT_FILE_NAME,
      Buffer.from(generationName(generation), "utf8"),
    );
    await this.fault?.("after-current-replace");
  }
}

/** Reads one secret tombstone (the fence written before a deletion proof). */
export async function readTombstone(
  root: string,
  ref: string,
): Promise<{ proof: string } | null> {
  const bytes = await readOwnedFile(
    tombstonePath(root, recordName(ref)),
  );

  if (bytes === null) {
    return null;
  }

  const value = parseJson(decodeUtf8(bytes));

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { ref?: unknown }).ref !== ref ||
    typeof (value as { proof?: unknown }).proof !== "string"
  ) {
    fail("STATE_RECOVERY_REQUIRED");
  }

  return { proof: (value as { proof: string }).proof };
}

/**
 * Writes (or replaces) the fence for one staged secret reference and returns the
 * proof the caller must present to delete the blob. The fence is durable before
 * the proof is issued.
 */
export async function writeTombstone(
  root: string,
  ref: string,
): Promise<string> {
  const proof = randomBytes(32).toString("base64url");

  await ensureOwnedDirectory(layoutOf(root).tombstones);
  await replaceOwnedFile(
    layoutOf(root).tombstones,
    recordName(ref),
    Buffer.from(JSON.stringify({ ref, proof }), "utf8"),
  );

  return proof;
}

export { recordName };
