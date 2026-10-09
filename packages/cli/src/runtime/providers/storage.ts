import { promises as fs } from "node:fs";
import path from "node:path";
import { parseStrictResponseJson } from "@syndroo/core";
import type { Implementation, ProviderApproval, ProviderManifest } from "@syndroo/core";
import { ensureOwnedDirectory, ensureStateRoot, readOwnedFile, replaceOwnedFile,
  requireOwnedDirectory, requireStateRoot, resolveStateRootPath, syncDirectory } from "../filesystem/atomic.js";
import { isMissing, reject } from "./errors.js";
import { digest, digestJson } from "./inspect.js";
import { checkedManifest, schemaFingerprint } from "./schema.js";
import type { ApprovalRecord, Inspection, NodeProviderOptions } from "./types.js";

export interface CatalogRecord {
  readonly format: "syndroo-provider-catalog-v1";
  readonly binding: string;
  readonly implementation: Implementation;
  /** JSON text avoids reducing the per-schema depth limit when nested in a storage envelope. */
  readonly manifest: string;
}

export function approvalRecord(inspection: Inspection, approval: ProviderApproval): ApprovalRecord {
  const c = inspection.candidate;
  return { format: "syndroo-provider-approval-v1", ...approval,
    providerId: c.provider, provenance: c.provenance, resolvedRoot: c.resolvedRoot, entrypoint: c.entrypoint,
    version: c.version, packageName: c.packageName, configFingerprint: inspection.configFingerprint,
    dependencySnapshot: inspection.dependencySnapshot };
}

export function validApproval(value: ProviderApproval): boolean {
  return !!value && typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/.test(value.fingerprint)
    && typeof value.approvedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.approvedAt)
    && Number.isFinite(Date.parse(value.approvedAt)) && new Date(value.approvedAt).toISOString() === value.approvedAt
    && ["interactive", "administrator", "distribution"].includes(value.source);
}

export function matchesApproval(inspection: Inspection, record: ApprovalRecord): boolean {
  return validApproval(record) && record.fingerprint === inspection.candidate.artifactFingerprint
    && digestJson(record) === digestJson(approvalRecord(inspection, {
      fingerprint: record.fingerprint, approvedAt: record.approvedAt, source: record.source,
    }));
}

/** Reads never create directories, change permissions, repair state or open the secrets area. */
export class ProviderRecords {
  constructor(private readonly options: NodeProviderOptions) {}

  private name(provider: string): string {
    return `${digest(`${this.options.configFile}\0${provider}`)}.json`;
  }

  private async read(area: "approvals" | "catalog", provider: string): Promise<unknown | null> {
    try {
      const resolved = await resolveStateRootPath(this.options.stateRoot);
      if (resolved.missing.length) return null;
      const root = await requireStateRoot(this.options.stateRoot);
      for (const directory of [path.join(root, "providers"), path.join(root, "providers", area)]) {
        try { await fs.lstat(directory); } catch (error) { if (isMissing(error)) return null; throw error; }
        await requireOwnedDirectory(directory);
      }
      const bytes = await readOwnedFile(path.join(root, "providers", area, this.name(provider)));
      return bytes === null ? null : parseStrictResponseJson(bytes);
    } catch { return reject("PROVIDER_STATE_INVALID"); }
  }

  private async write(area: "approvals" | "catalog", provider: string, value: unknown): Promise<void> {
    let directory: string;
    try {
      const before = await resolveStateRootPath(this.options.stateRoot);
      const root = await ensureStateRoot(this.options.stateRoot);
      const providers = await ensureOwnedDirectory(path.join(root, "providers"));
      directory = await ensureOwnedDirectory(path.join(providers, area));
      // The helper's rename syncs the file's directory; also persist newly created parent entries.
      for (let child = root; child !== before.resolved; child = path.dirname(child)) {
        await syncDirectory(path.dirname(child));
      }
      await syncDirectory(root);
      await syncDirectory(providers);
    } catch { return reject("PROVIDER_STATE_INVALID"); }
    try {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 1048576) return reject("PROVIDER_DURABILITY_ERROR");
      await replaceOwnedFile(directory, this.name(provider), bytes);
    } catch { return reject("PROVIDER_DURABILITY_ERROR"); }
  }

  async approval(provider: string): Promise<ApprovalRecord | null> {
    const value = await this.read("approvals", provider);
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return reject("PROVIDER_STATE_INVALID");
    const record = value as ApprovalRecord;
    if (record.format !== "syndroo-provider-approval-v1" || record.providerId !== provider || !validApproval(record)) {
      return reject("PROVIDER_STATE_INVALID");
    }
    return record;
  }

  async approve(record: ApprovalRecord): Promise<void> {
    await this.write("approvals", record.providerId, record);
  }

  async catalog(provider: string): Promise<{ record: CatalogRecord; manifest: ProviderManifest } | null> {
    const value = await this.read("catalog", provider);
    if (value === null) return null;
    try {
      const record = value as CatalogRecord;
      if (record.format !== "syndroo-provider-catalog-v1" || typeof record.manifest !== "string"
        || typeof record.binding !== "string" || record.implementation.provider !== provider) return reject("PROVIDER_STATE_INVALID");
      const manifest = checkedManifest(JSON.parse(record.manifest));
      if (manifest.id !== provider || manifest.version !== record.implementation.version
        || schemaFingerprint(manifest) !== record.implementation.schemaFingerprint) return reject("PROVIDER_STATE_INVALID");
      return { record, manifest };
    } catch { return reject("PROVIDER_STATE_INVALID"); }
  }

  async saveCatalog(provider: string, approval: ApprovalRecord, implementation: Implementation, manifest: ProviderManifest): Promise<void> {
    await this.write("catalog", provider, { format: "syndroo-provider-catalog-v1", binding: digestJson(approval),
      implementation, manifest: JSON.stringify(manifest) } satisfies CatalogRecord);
  }
}
