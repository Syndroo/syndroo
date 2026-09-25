import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectBundledPackages,
  describeBundledPackages,
  readLicenseSupplements,
  renderCliThirdPartyNotices,
  writeCliThirdPartyNotices,
} from "./cli-licenses.js";

const SCRIPT = fileURLToPath(new URL("./cli-licenses.js", import.meta.url));

assert.ok(
  existsSync(SCRIPT),
  `Compiled notices module missing at ${SCRIPT}. Run \`npm run build:scripts\` first.`,
);

describe("bundled package collection", () => {
  it("derives packages from real metafile inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-licenses-"));

    try {
      await writePackage(root, "zod", "3.25.76", "MIT", { "LICENSE": "T\n" });
      await writePackage(root, "@atproto/api", "0.20.42", "MIT", {
        "LICENSE.txt": "T\n",
      });
      await writePackage(root, "jsonc-parser", "3.3.1", "MIT", {
        "LICENSE.md": "T\n",
      });

      const metafile = {
        inputs: {
          "packages/cli/src/bin.ts": {},
          "node_modules/zod/lib/index.js": {},
          "node_modules/@atproto/api/dist/index.js": {},
          "node_modules/jsonc-parser/lib/esm/main.js": {},
        },
      };

      const collected = collectBundledPackages(metafile, root);

      assert.deepEqual(
        collected.map((entry) => entry.name),
        ["@atproto/api", "jsonc-parser", "zod"],
      );
      // Repository-owned source is not a third-party package.
      assert.equal(
        collected.some((entry) => entry.packageRoot.includes("packages/cli")),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an empty bundle", () => {
    assert.throws(
      () => collectBundledPackages({ inputs: {} }, "/repo"),
      /lists no inputs/u,
    );
    assert.throws(
      () => collectBundledPackages({}, "/repo"),
      /lists no inputs/u,
    );
  });
});

describe("notice generation", () => {
  it("reproduces shipped license text verbatim", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-licenses-"));

    try {
      await writePackage(root, "zod", "3.25.76", "MIT", {
        "LICENSE": "ZOD MIT TEXT\n",
      });

      const entries = await describeBundledPackages(
        { inputs: { "node_modules/zod/index.js": {} } },
        {
          workingDirectory: root,
          repositoryRoot: root,
          supplementDirectory: join(root, "licenses"),
          supplements: new Map(),
        },
      );

      const text = renderCliThirdPartyNotices(entries, "@syndroo/cli");

      assert.match(text, /zod 3\.25\.76/u);
      assert.match(text, /declared license: MIT/u);
      assert.match(text, /--- LICENSE ---/u);
      assert.match(text, /ZOD MIT TEXT/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when a bundled package ships no license and no supplement", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-licenses-"));

    try {
      await writePackage(root, "unlicensed", "1.0.0", "MIT", {});

      await assert.rejects(
        describeBundledPackages(
          { inputs: { "node_modules/unlicensed/index.js": {} } },
          {
            workingDirectory: root,
            repositoryRoot: root,
            supplementDirectory: join(root, "licenses"),
            supplements: new Map(),
          },
        ),
        /unlicensed@1\.0\.0 ships no license file/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a reviewed supplement for a package with no license file", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-licenses-"));

    try {
      await writePackage(root, "bare", "0.6.6", "MIT", {});
      await mkdir(join(root, "licenses"), { recursive: true });
      await writeFile(join(root, "licenses", "mit.txt"), "SUPPLEMENT TEXT\n", "utf8");

      const entries = await describeBundledPackages(
        { inputs: { "node_modules/bare/index.js": {} } },
        {
          workingDirectory: root,
          repositoryRoot: root,
          supplementDirectory: join(root, "licenses"),
          supplements: new Map([
            [
              "bare@0.6.6",
              {
                package: "bare",
                version: "0.6.6",
                declaredLicense: "MIT",
                licenseFile: "mit.txt",
                sourceUrl: "https://example.invalid/MIT.txt",
                note: "fixture supplement",
              },
            ],
          ]),
        },
      );

      const text = renderCliThirdPartyNotices(entries, "@syndroo/cli");

      assert.match(text, /SUPPLEMENT TEXT/u);
      assert.match(text, /text source: https:\/\/example\.invalid\/MIT\.txt/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes the notices inside the published dist directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-licenses-"));

    try {
      await writePackage(root, "zod", "3.25.76", "MIT", { "LICENSE": "T\n" });
      const dist = join(root, "dist");
      await mkdir(dist, { recursive: true });

      const written = await writeCliThirdPartyNotices({
        metafile: { inputs: { "node_modules/zod/index.js": {} } },
        workingDirectory: root,
        repositoryRoot: root,
        distDirectory: dist,
        packageName: "@syndroo/cli",
        supplementPath: join(root, "licenses", "third-party-license-supplements.json"),
        supplementDirectory: join(root, "licenses"),
      });

      assert.equal(written.path, resolve(dist, "THIRD_PARTY_LICENSES.txt"));
      assert.deepEqual(written.packages, ["zod@3.25.76"]);
      assert.match(await readFile(written.path, "utf8"), /THIRD-PARTY LICENSES/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads supplements keyed by exact version", async () => {
    const root = await mkdtemp(join(tmpdir(), "syndroo-cli-licenses-"));

    try {
      const path = join(root, "supplements.json");
      await writeFile(
        path,
        JSON.stringify({
          supplements: [
            {
              package: "bare",
              version: "0.6.6",
              declaredLicense: "MIT",
              licenseFile: "mit.txt",
              sourceUrl: "https://example.invalid/MIT.txt",
              note: "fixture",
            },
          ],
        }),
        "utf8",
      );

      const supplements = await readLicenseSupplements(path);

      assert.equal(supplements.size, 1);
      assert.equal(supplements.get("bare@0.6.6")?.licenseFile, "mit.txt");
      assert.equal(supplements.get("bare@0.6.7"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns no supplements when the file is absent", async () => {
    const supplements = await readLicenseSupplements("/nonexistent/supplements.json");

    assert.equal(supplements.size, 0);
  });
});

async function writePackage(
  root: string,
  name: string,
  version: string,
  license: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const directory = resolve(root, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name, version, license }, null, 2)}\n`,
    "utf8",
  );

  for (const [fileName, text] of Object.entries(files)) {
    await writeFile(join(directory, fileName), text, "utf8");
  }
}
