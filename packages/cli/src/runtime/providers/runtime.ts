import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LoadedProvider, ProviderCandidate, ProviderLoader, ProviderRegistry, ProviderView } from "@syndroo/core";
import { digestJson, inspectSelected, selectProviders, validProvider } from "./inspect.js";
import { reject, trustRequired } from "./errors.js";
import { approvalRecord, matchesApproval, ProviderRecords, validApproval } from "./storage.js";
import { checkedManifest, schemaFingerprint, validatePlugin } from "./schema.js";
import type { Inspection, NodeProviderOptions } from "./types.js";

/** Node caches transitive ESM/CJS imports by filename. Never mix two approved revisions in one process. */
const importedPackages = new Map<string, string>();

export interface NodeProviderRuntime {
  readonly loader: ProviderLoader;
  readonly registry: ProviderRegistry;
}

function sameCandidate(a: ProviderCandidate, b: ProviderCandidate): boolean {
  try { return digestJson(a) === digestJson(b); } catch { return false; }
}

export function createNodeProviderRuntime(input: NodeProviderOptions): NodeProviderRuntime {
  if (!input || typeof input.configFile !== "string" || typeof input.stateRoot !== "string"
    || !path.isAbsolute(input.configFile) || !path.isAbsolute(input.stateRoot)) return reject("PROVIDER_CONFIG_INVALID");
  let catalog: NonNullable<NodeProviderOptions["catalog"]>;
  try { catalog = structuredClone(input.catalog ?? []); } catch { return reject("PROVIDER_CONFIG_INVALID"); }
  if (!Array.isArray(catalog) || catalog.length > 100) return reject("PROVIDER_CONFIG_INVALID");
  const ids = new Set<string>();
  for (const entry of catalog) {
    if (!entry || !validProvider(entry.provider) || ids.has(entry.provider)
      || typeof entry.resolvedRoot !== "string" || !path.isAbsolute(entry.resolvedRoot)
      || !/^[0-9a-f]{64}$/.test(entry.artifactFingerprint)) return reject("PROVIDER_CONFIG_INVALID");
    const manifest = checkedManifest(entry.manifest);
    if (manifest.id !== entry.provider) return reject("PROVIDER_CONFIG_INVALID");
    ids.add(entry.provider);
  }
  const options: NodeProviderOptions = { configFile: path.normalize(input.configFile), stateRoot: path.normalize(input.stateRoot), catalog };
  const records = new ProviderRecords(options);
  const loaded = new Map<string, Promise<LoadedProvider>>();

  async function inspect(provider: string): Promise<Inspection> {
    if (!validProvider(provider)) return reject("PROVIDER_CONFIG_INVALID");
    return inspectSelected(provider, await selectProviders(options));
  }

  async function load(candidate: ProviderCandidate, readOnly: boolean): Promise<LoadedProvider> {
    let current = await inspect(candidate.provider);
    if (!sameCandidate(candidate, current.candidate)) return trustRequired(current.candidate);
    let approval = await records.approval(candidate.provider);
    if ((!approval || !matchesApproval(current, approval)) && current.builtin && !readOnly
      && current.builtin.artifactFingerprint === candidate.artifactFingerprint) {
      // Passing a fixed build catalog is distribution authorization; still persist it before import.
      await loader.approve(candidate, { fingerprint: candidate.artifactFingerprint,
        approvedAt: new Date().toISOString(), source: "distribution" });
      approval = await records.approval(candidate.provider);
    }
    if (!approval || !matchesApproval(current, approval)) return trustRequired(current.candidate);
    // No source or dependency bytes are copied. Repeat the full static check after reading the record.
    current = await inspect(candidate.provider);
    if (!sameCandidate(candidate, current.candidate) || !matchesApproval(current, approval)) return trustRequired(current.candidate);
    for (const pkg of current.dependencySnapshot.packages) {
      const previous = importedPackages.get(pkg.resolvedRoot);
      if (previous && previous !== pkg.fingerprint) return reject("PROVIDER_RESTART_REQUIRED");
    }
    const cacheKey = `${candidate.resolvedRoot}\0${candidate.artifactFingerprint}`;
    let pending = loaded.get(cacheKey);
    if (!pending) {
      // Reserve before import, including failed evaluations: Node also caches module errors.
      for (const pkg of current.dependencySnapshot.packages) importedPackages.set(pkg.resolvedRoot, pkg.fingerprint);
      pending = (async () => {
        let namespace: { default?: unknown };
        try { namespace = await import(/* @vite-ignore */ pathToFileURL(path.join(candidate.resolvedRoot, candidate.entrypoint)).href); }
        catch { return reject("PROVIDER_IMPORT_FAILED"); }
        return validatePlugin(namespace.default, candidate);
      })();
      loaded.set(cacheKey, pending);
    }
    const result = await pending;
    // Detect accidental mutation during module evaluation too; it never authorizes a new revision.
    const after = await inspect(candidate.provider);
    if (!matchesApproval(after, approval)) return trustRequired(after.candidate);
    if (!readOnly) await records.saveCatalog(candidate.provider, approval, result.implementation, result.plugin.manifest);
    return result;
  }

  const loader: ProviderLoader = {
    async inspect(provider) { return structuredClone((await inspect(provider)).candidate); },
    async approve(candidate, approval) {
      if (!validApproval(approval) || approval.fingerprint !== candidate.artifactFingerprint) return reject("PROVIDER_APPROVAL_INVALID");
      const current = await inspect(candidate.provider);
      if (!sameCandidate(candidate, current.candidate)) return trustRequired(current.candidate);
      if (approval.source === "distribution" && (!current.builtin
        || current.builtin.artifactFingerprint !== candidate.artifactFingerprint)) return reject("PROVIDER_APPROVAL_INVALID");
      await records.approve(approvalRecord(current, { fingerprint: approval.fingerprint,
        approvedAt: approval.approvedAt, source: approval.source }));
    },
    async load(candidate) { return load(candidate, false); },
  };

  const registry: ProviderRegistry = {
    async describe(provider): Promise<ProviderView> {
      if (!validProvider(provider)) return reject("PROVIDER_CONFIG_INVALID");
      const selection = await selectProviders(options);
      const selected = selection.roots.get(provider);
      const provenance = selected?.builtin ? "official" : "third_party";
      const base = { provider, provenance } as const;
      if (!selected) return { ...base, availability: "unavailable" };
      let current: Inspection;
      try { current = await inspectSelected(provider, selection); }
      catch { return { ...base, availability: "unavailable" }; }
      const approval = await records.approval(provider);
      const snapshot = await records.catalog(provider);
      if (approval && !matchesApproval(current, approval)) return { ...base, availability: "stale" };
      if (snapshot && approval && snapshot.record.binding === digestJson(approval)) {
        return { ...base, availability: "available", implementation: structuredClone(snapshot.record.implementation), manifest: structuredClone(snapshot.manifest) };
      }
      if (selected.builtin) {
        if (current.candidate.artifactFingerprint !== selected.builtin.artifactFingerprint) return { ...base, availability: "stale" };
        const manifest = selected.builtin.manifest;
        return { ...base, availability: "available", manifest: structuredClone(manifest), implementation: {
          provider, packageName: current.candidate.packageName, version: current.candidate.version, apiVersion: 1,
          artifactFingerprint: current.candidate.artifactFingerprint, schemaFingerprint: schemaFingerprint(manifest),
        } };
      }
      return { ...base, availability: approval ? "unavailable" : "untrusted" };
    },
    async list() {
      const selection = await selectProviders(options);
      const views = [];
      for (const provider of [...selection.roots.keys()].sort()) {
        const { manifest: _manifest, ...view } = await registry.describe(provider);
        views.push(view);
      }
      return views;
    },
    async load(provider, mode = "active") {
      return load((await inspect(provider)).candidate, mode === "read_only");
    },
  };
  return { loader, registry };
}
