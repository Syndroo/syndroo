import { ProtocolError } from "@syndroo/core";
import type { ProviderCandidate } from "@syndroo/core";

export type ProviderLoaderCode =
  | "PROVIDER_CONFIG_INVALID" | "PROVIDER_UNAVAILABLE" | "PROVIDER_METADATA_INVALID"
  | "PROVIDER_ENTRYPOINT_INVALID" | "PROVIDER_ARTIFACT_INVALID" | "PROVIDER_DEPENDENCY_INVALID"
  | "PROVIDER_TRUST_REQUIRED" | "PROVIDER_APPROVAL_INVALID" | "PROVIDER_STATE_INVALID"
  | "PROVIDER_DURABILITY_ERROR" | "PROVIDER_INVALID" | "PROVIDER_ID_MISMATCH"
  | "PROVIDER_VERSION_MISMATCH" | "PROVIDER_API_INCOMPATIBLE" | "PROVIDER_SCHEMA_INVALID"
  | "PROVIDER_IMPORT_FAILED" | "PROVIDER_RESTART_REQUIRED";

export function reject(code: ProviderLoaderCode): never {
  throw new ProtocolError(code);
}

export function trustRequired(candidate: ProviderCandidate): never {
  const error = new ProtocolError("PROVIDER_TRUST_REQUIRED");
  // Only inspected local source metadata, escaped and bounded; never a plugin exception.
  error.message = `PROVIDER_TRUST_REQUIRED: ${JSON.stringify(candidate.resolvedRoot.slice(0, 1024))} version ${JSON.stringify(candidate.version)}`;
  throw error;
}

export function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
