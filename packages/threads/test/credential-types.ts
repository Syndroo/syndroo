/**
 * Compile-negative credential fixtures.
 *
 * `vitest` transpiles without typechecking, so this file exists to be compiled
 * by `tsc -p tsconfig.test.json`, which the package `check` script runs. Every
 * `@ts-expect-error` fails the build if its line ever starts typechecking.
 */
import { buildThreadsPublisher, decodeThreadsCredential } from "../src/index.js";

decodeThreadsCredential({ access_token: "token" });

// @ts-expect-error - accessToken is required on the typed credential
buildThreadsPublisher({});

// @ts-expect-error - the raw snake_case record is not a typed credential
buildThreadsPublisher({ access_token: "token" });

// @ts-expect-error - accessToken must be a string
buildThreadsPublisher({ accessToken: 42 });
