/**
 * Compile-time fixture for the documented public API.
 *
 * This file is type-checked by `tsconfig.test.json` and never collected by
 * Vitest (it is not a `*.test.ts`). It exists so signature drift — a moved
 * options argument, a dropped overload, an unguarded revision — fails
 * `npm run check` instead of a runtime test.
 */

import {
  SyndrooClient,
  type AuthCompleteInput,
  type AuthMutationOptions,
  type AuthOperationStatus,
  type AuthRefreshReceipt,
  type AuthRemoveReceipt,
  type AuthRequestOptions,
  type AuthSetReceipt,
  type AuthStatus,
  type CompleteReceipt,
  type ConnectReceipt,
  type Diagnostics,
  type PlatformStatus,
} from "../src/index.js";

declare const syndroo: SyndrooClient;
declare const requestOptions: AuthRequestOptions;
declare const mutationOptions: AuthMutationOptions;
declare const completeInput: AuthCompleteInput;

// auth.status(platform?, options?) — the documented platform-optional form.
const list: Promise<AuthStatus> = syndroo.auth.status();
const listWithUndefined: Promise<AuthStatus> = syndroo.auth.status(undefined, requestOptions);
const listWithOptions: Promise<AuthStatus> = syndroo.auth.status(requestOptions);
const single: Promise<PlatformStatus> = syndroo.auth.status("bluesky");
const singleWithOptions: Promise<PlatformStatus> = syndroo.auth.status("bluesky", requestOptions);

// Mutations: the observed revision travels inside the documented argument.
const set: Promise<AuthSetReceipt> = syndroo.auth.set(
  "bluesky",
  { identifier: "alice" },
  mutationOptions,
);
const connect: Promise<ConnectReceipt> = syndroo.auth.connect("x", mutationOptions);
const operation: Promise<AuthOperationStatus> = syndroo.auth.operation(
  "x",
  "op_1",
  requestOptions,
);
// complete(platform, id, { expectedRevision, target? }, options?) — four arguments.
const complete: Promise<CompleteReceipt> = syndroo.auth.complete(
  "linkedin",
  "op_1",
  completeInput,
  requestOptions,
);
const refresh: Promise<AuthRefreshReceipt> = syndroo.auth.refresh("x", mutationOptions);
const remove: Promise<AuthRemoveReceipt> = syndroo.auth.remove("x", mutationOptions);
const diagnostics: Promise<Diagnostics> = syndroo.diagnostics(requestOptions);

// The revision is mandatory on every new mutation.
// @ts-expect-error set requires expectedRevision
syndroo.auth.set("bluesky", { identifier: "alice" }, {});
// @ts-expect-error connect requires expectedRevision
syndroo.auth.connect("x", {});
// @ts-expect-error complete requires expectedRevision
syndroo.auth.complete("x", "op_1", {});
// @ts-expect-error refresh requires expectedRevision
syndroo.auth.refresh("x", {});
// @ts-expect-error remove requires expectedRevision
syndroo.auth.remove("x", {});

// The read APIs keep their documented calls without extra arguments.
const noArgs: ReadonlyArray<Promise<unknown>> = [
  syndroo.posts.create({ content: "Hello", platforms: ["bluesky"] }),
  syndroo.posts.get("post_1"),
  syndroo.posts.list(),
  syndroo.posts.wait("post_1"),
  syndroo.health(),
];

export {
  complete,
  connect,
  diagnostics,
  list,
  listWithOptions,
  listWithUndefined,
  noArgs,
  operation,
  refresh,
  remove,
  set,
  single,
  singleWithOptions,
};
