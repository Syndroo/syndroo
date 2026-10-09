import type { ProviderApproval, ProviderCandidate, ProviderManifest } from "@syndroo/core";

/** Generated JSON data only. Importing provider packages to construct this is forbidden. */
export interface BuiltinProviderCatalogEntry {
  /** Provider id: the registry key and the manifest id. */
  readonly provider: string;
  /**
   * Installed package name, for example `@syndroo/provider-bluesky`.
   *
   * A packed CLI resolves this through `node_modules` first; the checkout path
   * below is only the in-repository fallback. See `resolveBuiltinRoot` in
   * `runtime/local/composition.ts`.
   */
  readonly packageName: string;
  /**
   * Repository-relative checkout path, for example `packages/provider-bluesky`.
   *
   * Never absolute: the generated artifact must survive a moved checkout and
   * must not embed a build path. Resolve it against the repository root.
   */
  readonly resolvedRoot: string;
  readonly artifactFingerprint: string;
  readonly manifest: ProviderManifest;
}

export interface NodeProviderOptions {
  /** Absolute path selected by --config. Relative provider paths use this directory. */
  readonly configFile: string;
  readonly stateRoot: string;
  readonly catalog?: readonly BuiltinProviderCatalogEntry[];
}

export interface DependencySnapshot {
  readonly policy: "syndroo-artifact-v1";
  readonly packages: readonly {
    readonly resolvedRoot: string;
    readonly name: string;
    readonly version: string;
    readonly fingerprint: string;
    readonly dependencies: Readonly<Record<string, string | null>>;
  }[];
  readonly locks: readonly { readonly path: string; readonly fingerprint: string }[];
}

export interface Inspection {
  readonly candidate: ProviderCandidate;
  readonly configFingerprint: string;
  readonly dependencySnapshot: DependencySnapshot;
  readonly entrypointHash: string;
  readonly builtin?: BuiltinProviderCatalogEntry;
}

export interface ApprovalRecord extends ProviderApproval {
  readonly format: "syndroo-provider-approval-v1";
  readonly providerId: string;
  readonly provenance: ProviderCandidate["provenance"];
  readonly resolvedRoot: string;
  readonly entrypoint: string;
  readonly version: string;
  readonly packageName: string;
  readonly configFingerprint: string;
  readonly dependencySnapshot: DependencySnapshot;
}
