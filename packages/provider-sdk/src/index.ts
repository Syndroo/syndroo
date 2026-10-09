/**
 * `@syndroo/provider-sdk` root export.
 *
 * The root surface is the public Provider contract plus `defineProvider`. It is
 * inert on import: no schema compilation, no filesystem or network access, no
 * clock read and no provider import happens while this module loads.
 *
 * A provider package's own default export is its plugin object, not a factory:
 *
 * ```ts
 * import { defineProvider } from "@syndroo/provider-sdk";
 * export default defineProvider({ manifest, connect, freeze, publish });
 * ```
 *
 * `providerContractTests` is intentionally absent. It lives on the `/testing`
 * subpath (`./testing.js`) so a production dependency graph never reaches test
 * scaffolding; `test/contract.test.ts` proves that statically.
 */

export * from "./types.js";
export { DEFINITION_LIMITS, ProviderDefinitionError, defineProvider } from "./define-provider.js";
export type { ProviderDefinitionErrorCode } from "./define-provider.js";
