# Node provider registry and trust loader

`index.ts` exports the synchronous factory
`createNodeProviderRuntime(options: NodeProviderOptions): { registry: ProviderRegistry; loader: ProviderLoader }`.
All filesystem work happens in its asynchronous methods. `options` contains an absolute
`configFile`, an absolute `stateRoot`, and an optional data-only `catalog` array. An omitted
catalog is empty. There are no eager imports of official providers.

The selected JSON config uses `providers: { "<id>": { "path": "./plugin" } }`.
Paths resolve against the selected config file's directory, never the process cwd or the
CLI installation. An override replaces the catalog entry, including its provenance.
An invalid override never falls back. Package names and plugin-supplied fields cannot
establish official provenance.

## Inspection and fingerprint policy

Policy name: `syndroo-artifact-v1`. Inspection performs static filesystem reads only.
It does not import modules, resolve source import specifiers, execute lifecycle scripts,
scan installed packages, install packages, or use the network.

Each package root is canonicalized with `realpath`. Within it, included files must be
regular files; symlinked files/directories, sockets, devices and FIFOs are refused. The
walk is sorted by JavaScript string ordering. Exact directory names, compared case
insensitively, excluded from the walk are `node_modules`, `.git`, `test`, `tests`,
`__tests__`, `spec`, `specs`, `__specs__`. Regular files ending in `.md` or starting with
`LICENSE` or `NOTICE` are excluded, case insensitively. Other files, including JSON,
source maps, and unreferenced source files, contribute their bytes. Excluded material
must not be used as runtime code. Nested `node_modules` below the package root are
rejected because they could change dependency resolution for an internal module.

The per-package SHA-256 digest covers sorted relative filenames and the SHA-256 of
each file's bytes. The artifact digest covers the package name/version, selected
entrypoint, every package digest, and the declared dependency graph. Absolute paths
are bound in the approval record, rather than in the relocatable artifact digest.
Limits across one graph: 128 packages, 8,192 files, 16,384 directory entries,
32 directory levels, 64 MiB total, 8 MiB per file;
package metadata and config are each at most 64 KiB. Reads are bounded and use
`O_NOFOLLOW | O_NONBLOCK`, checking regular-file identity/size/times before and after.

Only explicitly named `dependencies`, `peerDependencies`, and `optionalDependencies`
are located. The loader checks exact `node_modules/<name>` candidates along the
resolved package's ancestors, following Node's package lookup basis, without listing
`node_modules`. Resolved package roots, actual versions, content digests, dependency
edges and optional absences are recorded. A missing required dependency is refused.
The selected roots may be workspace package symlinks; internal artifact symlinks are
refused. Available `npm-shrinkwrap.json`, `package-lock.json`, `pnpm-lock.yaml`, and
`yarn.lock` files at the config directory and root package are also fingerprinted and
bound to approval. Actual dependency bytes are checked regardless of lockfile presence;
this is not a package-manager lockfile audit. Dependency declarations must include all
runtime dependencies. Code that deliberately imports arbitrary external paths is
trusted executable code, beyond this metadata contract.

The root entrypoint must be one explicit `./...js` or `./...mjs` file in the artifact.
`.js` requires `type: "module"`. `exports` takes precedence over `main`; the root `.`
export is used when subpath exports exist. Supported root conditions `node`, `import`
and `default` must yield the same single file; `types`, `require`, and `browser` are
not Node ESM entrypoints. Arrays, divergent candidates, traversal, missing files, and
duplicate JSON metadata keys are rejected before evaluation. No implicit index search.

## Approval and loading

The host displays the inspected candidate, obtains explicit authorization, and calls
`loader.approve(candidate, { fingerprint, approvedAt, source })`. Third-party approval
sources are `interactive` or `administrator`; `distribution` is accepted only for an
exact artifact in the supplied build catalog. Passing that catalog is fixed distribution
authorization: the first active built-in load persists its distribution approval before
importing. A read-only load never creates that approval.

Approval files live at `stateRoot/providers/approvals/<config-and-provider-hash>.json`.
They hold the required fingerprint, time, source, provenance, providerId, resolvedRoot,
entrypoint, version and dependencySnapshot, plus packageName/config fingerprint/format.
Directories are `0700`; files are `0600`. This module reuses the filesystem runtime's
ownership checks, bounded reads, temporary-file fsync, atomic rename, and directory
fsync. It also syncs newly created parent directory entries. Persistence failure rejects
approval and never proceeds to import. No plugin or dependency bytes are copied.

Load inspects again, reads the matching approval, repeats the entire source/dependency
fingerprint check immediately before native `import()`, and validates the default export.
Provider id, API integer 1 and package/manifest version must agree. Each schema retains
the SDK's 64 KiB/depth-32 bound and is meta-schema-validated/compiled by Ajv2020, with
formats, no coercion, no defaults, no field removal, no remote references or asynchronous
schema loading. Errors contain no raw plugin exception or cause. Source drift observed
after import also fails closed. There is no automatic fallback.

Node caches transitive imports by filename. If an artifact already evaluated in this
process changes, a newly approved revision requires a fresh process and produces
`PROVIDER_RESTART_REQUIRED` until then. New CLI invocations/new server startups select
the new revision; the loader does not append cache-busting query strings that would
leave old dependencies cached. The loader must own provider imports in the host process.

The pre-import recheck detects changed artifacts; it is not an atomic filesystem/import
operation. A same-user attacker racing files or trusted plugin code using host permissions
is not contained. Keep installed artifacts stable for the lifetime of the process. No
sandbox or production-readiness claim is made.

## Read-only catalog

After a successful active load, the validated manifest/implementation is saved as a
protected catalog record bound to the approval. `describe` and `list` only serve that
saved data or the supplied build catalog. They statically inspect current metadata to
mark changes, but never import providers, compile schemas, read secrets, or write state.
`list` omits full schemas. An approved third-party artifact without a validated saved
manifest is `unavailable`; absent trust is `untrusted`, changed binding/artifact is
`stale`, and missing/invalid source is `unavailable`. `registry.load(id, "read_only")`
may import approved code for dry-run but never saves a catalog or approval.

## Error contract and pending wiring

Branch on the thrown error's **`code: string`** property; it extends Core's `ProtocolError`.
The safe `message` is the code, except `PROVIDER_TRUST_REQUIRED`, which also identifies
the bounded, escaped resolved source and package version. Do not branch on message text.

| Code | Meaning |
| --- | --- |
| `PROVIDER_TRUST_REQUIRED` | No matching approval; artifact/config/lock/dependency binding changed; inspected candidate replaced |
| `PROVIDER_UNAVAILABLE` | No registered id or configured package root is absent |
| `PROVIDER_CONFIG_INVALID` | Invalid selected config, path, provider id, or catalog |
| `PROVIDER_METADATA_INVALID` | Invalid package identity/version or duplicate/malformed package JSON |
| `PROVIDER_ENTRYPOINT_INVALID` | Missing, ambiguous, unsupported, or escaping entrypoint |
| `PROVIDER_ARTIFACT_INVALID` | Unsafe file kind/path, changed read, or inspection bound exceeded |
| `PROVIDER_DEPENDENCY_INVALID` | Missing/mismatched dependency or invalid dependency/lock metadata |
| `PROVIDER_APPROVAL_INVALID` | Invalid approval fields, wrong fingerprint, or unauthorized distribution provenance |
| `PROVIDER_STATE_INVALID` | Unsafe/unreadable/corrupt protected records or directory ownership/mode |
| `PROVIDER_DURABILITY_ERROR` | Approval/catalog atomic persistence failed |
| `PROVIDER_ID_MISMATCH` / `PROVIDER_VERSION_MISMATCH` | Evaluated manifest disagrees with selected package |
| `PROVIDER_API_INCOMPATIBLE` | Provider API is not integer 1 |
| `PROVIDER_SCHEMA_INVALID` | Invalid, unsafe or oversized declared schema |
| `PROVIDER_INVALID` | Invalid default export/contract |
| `PROVIDER_IMPORT_FAILED` | Native evaluation failed; original exception is suppressed |
| `PROVIDER_RESTART_REQUIRED` | Already evaluated code/dependency changed within this process |

The existing scripts do not generate a built-in provider catalog. The generator owner
must supply `BuiltinProviderCatalogEntry[]` data containing `provider`, `resolvedRoot`,
`artifactFingerprint`, and `manifest`, computed from the fixed built distribution. The
catalog must not be assembled by eagerly importing providers during CLI startup/status.
The manifest owner must expose the Node runtime subpath and declare `ajv` (8.x) and
`ajv-formats` (3.x) as CLI runtime dependencies. No manifest or generator is modified here.
