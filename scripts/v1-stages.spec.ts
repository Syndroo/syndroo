import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { STAGES } from "./lib/v1-stages.js";

/**
 * The build order has to be a fact about the dependency graph, not a convention.
 *
 * A cold `npm run build` in a tree with no `dist` anywhere fails when a consumer
 * is built before the package it imports: `@syndroo/server` reuses the CLI's
 * provider runtime, so building it before `@syndroo/cli` made every fresh
 * checkout fail the first build. These tests read the workspace manifests and
 * refuse that shape, so a new edge cannot be added without an order to match.
 */

type Manifest = {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

function manifestOf(directory: string): Manifest {
  return JSON.parse(
    readFileSync(join(process.cwd(), "packages", directory, "package.json"), "utf8"),
  ) as Manifest;
}

/** Every workspace this package names in a runtime, dev or peer dependency map. */
function workspaceDependencies(directory: string): string[] {
  const manifest = manifestOf(directory);
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];

  return declared.filter((name) => STAGES.some((stage) => stage.name === name));
}

describe("architecture-v1 build order", () => {
  it("puts every workspace after the workspaces it depends on", () => {
    const position = new Map(STAGES.map((stage, index) => [stage.name, index]));

    for (const stage of STAGES) {
      for (const dependency of workspaceDependencies(stage.dir)) {
        const consumer = position.get(stage.name) as number;
        const provider = position.get(dependency) as number;

        assert.ok(
          provider < consumer,
          `${stage.name} is built before ${dependency}, which its manifest depends on`,
        );
      }
    }
  });

  it("keeps the contract order every consumer relies on", () => {
    const order = STAGES.map((stage) => stage.name);

    assert.deepEqual(order, [
      "@syndroo/provider-sdk",
      "@syndroo/core",
      "@syndroo/provider-bluesky",
      "@syndroo/provider-threads",
      "@syndroo/provider-linkedin",
      "@syndroo/provider-mastodon",
      "@syndroo/provider-devto",
      "@syndroo/sdk",
      "@syndroo/cli",
      "@syndroo/server",
      "@syndroo/cloudflare",
    ]);
  });

  it("keeps cli before server, the edge that broke a cold build", () => {
    const order = STAGES.map((stage) => stage.name);

    assert.ok(order.indexOf("@syndroo/cli") < order.indexOf("@syndroo/server"));
    assert.ok(workspaceDependencies("server").includes("@syndroo/cli"));
  });
});
