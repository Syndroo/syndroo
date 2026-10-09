import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { OAuthError } from "./errors.js";

/**
 * The durable, single-use attempt record behind one OAuth redirect.
 *
 * The store is keyed by an **HMAC digest** of the adapter's own `state`, never
 * by the state itself: a reader of these files learns which attempt an unknown
 * state belongs to only by guessing a 256-bit value first. The raw state, the
 * authorization code and the PKCE verifier are never written here.
 *
 * Claiming is one `open(..., "wx")`, which is atomic on a POSIX filesystem, so
 * two concurrent deliveries of the same redirect cannot both admit. `release`
 * puts an attempt back only when nothing was committed.
 *
 * The digest subkey is derived from a per-state-root random secret created on
 * first use. It is the only file in this directory whose content is a key.
 */

const DIGEST_KEY_BYTES = 32;
const KEY_FILE = "digest-key";
const DIRECTORY = "oauth-attempts";
const RECORD_FILES = /^[a-f0-9]{64}\.json$/;
const CLAIM_FILES = /^[a-f0-9]{64}\.used$/;

export type OAuthAttempt = {
  readonly provider: string;
  readonly sessionId: string;
  readonly stepRevision: number;
  readonly redirectUri: string;
  /** Origin the browser was actually sent to; the authorization-server identity. */
  readonly issuer: string;
  readonly createdAt: string;
  readonly expiresAt: string;
};

export type ClaimResult = "claimed" | "used" | "error";

/** Owner-only modes: directories 0700, files 0600, as for the rest of state. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type Logger = (message: string) => void;

export class FilesystemOAuthAttempts {
  readonly #directory: string;
  readonly #keyPath: string;
  #key: Buffer | undefined;

  constructor(input: { readonly stateRoot: string; readonly diagnostic?: Logger }) {
    this.#directory = path.join(input.stateRoot, DIRECTORY);
    this.#keyPath = path.join(this.#directory, KEY_FILE);
  }

  /** The one-way key for one state; never returns or logs the state. */
  async digest(state: string): Promise<string> {
    const key = await this.#digestKey();

    return createHmac("sha256", key).update(state, "utf8").digest("hex");
  }

  /** Write one attempt. A repeated digest is refused, never overwritten. */
  async create(stateDigest: string, attempt: OAuthAttempt): Promise<void> {
    await this.#ensureDirectory();

    await fs.writeFile(this.#recordPath(stateDigest), `${JSON.stringify(attempt)}\n`, {
      flag: "wx",
      mode: FILE_MODE,
    });
  }

  /** Read one attempt, or `null` when the digest is unknown or unreadable. */
  async read(stateDigest: string): Promise<OAuthAttempt | null> {
    let text: string;

    try {
      text = await fs.readFile(this.#recordPath(stateDigest), "utf8");
    } catch {
      return null;
    }

    try {
      const value = JSON.parse(text) as Partial<OAuthAttempt>;

      if (
        typeof value.provider !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.stepRevision !== "number" ||
        typeof value.redirectUri !== "string" ||
        typeof value.issuer !== "string" ||
        typeof value.createdAt !== "string" ||
        typeof value.expiresAt !== "string"
      ) {
        return null;
      }

      return value as OAuthAttempt;
    } catch {
      return null;
    }
  }

  /**
   * Take the single-use claim for one attempt.
   *
   * `used` says another delivery already claimed it; `error` says the claim
   * could not be taken for a reason that is not "already claimed", and the
   * caller must fail closed rather than proceed without a claim.
   */
  async claim(stateDigest: string): Promise<ClaimResult> {
    await this.#ensureDirectory();

    try {
      const handle = await fs.open(this.#claimPath(stateDigest), "wx", FILE_MODE);

      await handle.close();

      return "claimed";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? "used" : "error";
    }
  }

  /** Put an uncommitted attempt back so a later, valid delivery may claim it. */
  async release(stateDigest: string): Promise<void> {
    await fs.rm(this.#claimPath(stateDigest), { force: true }).catch(() => undefined);
  }

  /**
   * Drop attempts whose expiry has passed, plus their claims.
   *
   * Best effort: a leftover record is a stale non-secret, never an admission,
   * because the expiry is re-checked on every claim.
   */
  async sweep(now: string): Promise<void> {
    let entries: string[];

    try {
      entries = await fs.readdir(this.#directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!RECORD_FILES.test(entry)) {
        continue;
      }

      const digest = entry.slice(0, 64);
      const attempt = await this.read(digest);

      if (attempt === null || attempt.expiresAt > now) {
        continue;
      }

      await fs.rm(path.join(this.#directory, entry), { force: true }).catch(() => undefined);
      await this.release(digest);
    }

    for (const entry of entries) {
      if (!CLAIM_FILES.test(entry)) {
        continue;
      }

      const digest = entry.slice(0, 64);
      const attempt = await this.read(digest);

      if (attempt === null) {
        await this.release(digest);
      }
    }
  }

  #recordPath(stateDigest: string): string {
    return path.join(this.#directory, `${stateDigest}.json`);
  }

  #claimPath(stateDigest: string): string {
    return path.join(this.#directory, `${stateDigest}.used`);
  }

  async #ensureDirectory(): Promise<void> {
    await fs.mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
  }

  /**
   * The per-root digest key, created on first use.
   *
   * `wx` makes concurrent first use a race the loser simply reads, and a
   * too-short or malformed file is replaced only by failing closed: without a
   * full-length key no digest is produced, so no attempt can be recorded or
   * matched.
   */
  async #digestKey(): Promise<Buffer> {
    if (this.#key !== undefined) {
      return this.#key;
    }

    await this.#ensureDirectory();

    try {
      const handle = await fs.open(this.#keyPath, "wx", FILE_MODE);

      try {
        await handle.writeFile(`${randomBytes(DIGEST_KEY_BYTES).toString("hex")}\n`);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new OAuthError("OAUTH_ATTEMPT_STORE_UNAVAILABLE");
      }
    }

    const text = (await fs.readFile(this.#keyPath, "utf8")).trim();
    const key = Buffer.from(text, "hex");

    if (key.length !== DIGEST_KEY_BYTES) {
      throw new OAuthError("OAUTH_ATTEMPT_STORE_UNAVAILABLE");
    }

    this.#key = key;

    return key;
  }
}

/** Constant-time comparison for two digests of equal length. */
export function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");

  return a.length === b.length && timingSafeEqual(a, b);
}
