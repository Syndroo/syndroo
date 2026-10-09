/**
 * Public surface of `@syndroo/server`.
 *
 * The package ships a Node HTTP server: the self-hosted runtime composition and
 * the request handler. `@syndroo/server/http` is the subpath the Worker bundle
 * imports; the root entry is the fuller Node surface an embedder starts from.
 *
 * The manifest already declared this entry (`main` and `exports["."]` point at
 * `dist/index.js`); the file was the missing half of that contract.
 */
export * from "./compose/index.js";
export * from "./http/index.js";
