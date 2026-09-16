import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectBundledSources,
  derivePackageRootFromFile,
  packageNameFromRoot,
  selectLicenseArtifacts,
} from "./package-support.js";

const GENERATOR = fileURLToPath(
  new URL("./generate-package-licenses.js", import.meta.url),
);

assert.ok(
  existsSync(GENERATOR),
  `Compiled license generator missing at ${GENERATOR}. Run \`npm run build:scripts\` first.`,
);

// Shape of the vendored standard text: the copyright line keeps the unmodified
// placeholder, because no holder or year may be asserted for the upstream package.
const MIT_TEXT = [
  "MIT License",
  "",
  "Copyright (c) <year> <copyright holders>",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\".",
  "",
].join("\n");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("bundled package resolution", () => {
  it("identifies the exact package instance, including nested versions", async () => {
    const root = await createTree({
      "packages/cloudflare-worker/dist/index.js": "",
      "packages/cloudflare-worker/src/index.ts": "",
      "node_modules/mit-pkg/index.js": "",
      "node_modules/mit-pkg/package.json": '{"name":"mit-pkg","version":"1.0.0"}',
      "node_modules/other/node_modules/mit-pkg/index.js": "",
      "node_modules/other/node_modules/mit-pkg/package.json":
        '{"name":"mit-pkg","version":"2.0.0"}',
    });
    const mapDirectory = resolve(root, "packages/cloudflare-worker/dist");

    const { sources, unresolved } = collectBundledSources(
      {
        version: 3,
        sourceRoot: "dist",
        sources: [
          "../../../node_modules/mit-pkg/index.js",
          "../../../node_modules/other/node_modules/mit-pkg/index.js",
          "../../src/index.ts",
          "../../../node_modules/absent-pkg/index.js",
        ],
      },
      mapDirectory,
    );

    assert.deepEqual(
      sources.map(
        (entry) => `${entry.packageName}@${relative(root, entry.packageRoot)}`,
      ),
      [
        "mit-pkg@node_modules/mit-pkg",
        "mit-pkg@node_modules/other/node_modules/mit-pkg",
      ],
    );
    assert.deepEqual(unresolved, ["../../../node_modules/absent-pkg/index.js"]);
  });

  it("keeps repository sources out of the third-party list", async () => {
    const root = await createTree({
      "packages/cloudflare-worker/dist/index.js": "",
      "packages/core/src/index.ts": "",
    });
    const mapDirectory = resolve(root, "packages/cloudflare-worker/dist");
    const { sources, unresolved } = collectBundledSources(
      { sources: ["../../core/src/index.ts"], sourceRoot: "dist" },
      mapDirectory,
    );

    assert.deepEqual(sources, []);
    assert.deepEqual(unresolved, []);
  });

  it("identifies a bundled package whose published source map points at unpublished files", async () => {
    const root = await createTree({
      "packages/cloudflare-worker/dist/index.js": "",
      "node_modules/xdk/package.json": '{"name":"xdk","version":"1.0.0"}',
    });
    const { sources, unresolved } = collectBundledSources(
      { sources: ["../../../node_modules/xdk/src/index.ts"] },
      resolve(root, "packages/cloudflare-worker/dist"),
    );

    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.packageName, "xdk");
    assert.equal(sources[0]?.packageRoot, resolve(root, "node_modules/xdk"));
    assert.equal(sources[0]?.fileExists, false);
    assert.deepEqual(unresolved, []);
  });

  it("derives the package root from the path, ignoring nested manifests", async () => {
    const root = await createTree({
      "node_modules/pkg/package.json": '{"name":"pkg"}',
      "node_modules/pkg/dist/deep/file.js": "",
      "node_modules/@babel/runtime/package.json": '{"name":"@babel/runtime"}',
      "node_modules/@babel/runtime/helpers/esm/package.json": '{"type":"module"}',
      "node_modules/@babel/runtime/helpers/esm/helpers.js": "",
    });

    assert.equal(
      derivePackageRootFromFile(resolve(root, "node_modules/pkg/dist/deep/file.js")),
      resolve(root, "node_modules/pkg"),
    );
    assert.equal(
      derivePackageRootFromFile(
        resolve(root, "node_modules/@babel/runtime/helpers/esm/helpers.js"),
      ),
      resolve(root, "node_modules/@babel/runtime"),
    );
    assert.equal(
      packageNameFromRoot(resolve(root, "node_modules/@scope/pkg")),
      "@scope/pkg",
    );
  });
});

describe("license artifact selection", () => {
  it("accepts versioned license names and keeps notices separate", () => {
    assert.deepEqual(
      selectLicenseArtifacts([
        "README.md",
        "LICENSE-MIT",
        "COPYING",
        "NOTICE.txt",
        "NOTICE",
      ]),
      { licenseFiles: ["COPYING", "LICENSE-MIT"], noticeFiles: ["NOTICE", "NOTICE.txt"] },
    );
  });

  it("does not treat a notice as license text", () => {
    assert.deepEqual(selectLicenseArtifacts(["NOTICE", "COPYRIGHT"]), {
      licenseFiles: [],
      noticeFiles: ["COPYRIGHT", "NOTICE"],
    });
    assert.deepEqual(selectLicenseArtifacts(["README.md", "package.json"]), {
      licenseFiles: [],
      noticeFiles: [],
    });
  });
});

describe("license generation", () => {
  const fixtures: string[] = [];

  after(async () => {
    for (const fixture of fixtures) {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("refuses to generate a license file when a bundled package ships no license text", async () => {
    const fixture = await createRepositoryFixture({ withMissingLicense: true });
    const result = runGenerator(fixture);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to package without complete third-party license text/);
    assert.match(result.stderr, /no-license-pkg/);
    assert.equal(
      existsSync(resolve(fixture, "packages/cloudflare-worker/dist/THIRD_PARTY_LICENSES.txt")),
      false,
    );
  });

  it("writes license and notice text for every bundled package", async () => {
    const fixture = await createRepositoryFixture({ withMissingLicense: false });
    const first = runGenerator(fixture);

    assert.equal(first.status, 0, first.stderr);

    const licensePath = resolve(
      fixture,
      "packages/cloudflare-worker/dist/THIRD_PARTY_LICENSES.txt",
    );
    const contents = await readFile(licensePath, "utf8");
    const second = runGenerator(fixture);

    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      await readFile(licensePath, "utf8"),
      contents,
      "license output is not reproducible",
    );
    assert.match(contents, /Included packages: 3/);
    assert.match(contents, /mit-pkg 1\.0\.0/);
    assert.match(contents, /declared license: MIT/);
    assert.match(contents, /no-field-pkg 2\.0\.0/);
    assert.match(contents, /declared license: not declared in package\.json/);
    assert.match(contents, /Apache License/);
    assert.match(contents, /NOTICE of bundled work/);
    assert.ok(
      contents.indexOf("mit-pkg") < contents.indexOf("no-field-pkg"),
      "license entries must be sorted by package name",
    );
  });

  it("supplies reviewed standard terms when a bundled package ships none", async () => {
    const fixture = await createRepositoryFixture({
      withMissingLicense: true,
      supplement: {
        package: "no-license-pkg",
        version: "4.0.0",
        declaredLicense: "MIT",
        licenseFile: "mit.txt",
        sourceUrl: "https://example.invalid/mit",
        sourceSha256: sha256(MIT_TEXT),
        note: "Recorded supplement for a package that ships no license file.",
      },
    });
    const result = runGenerator(fixture);

    assert.equal(result.status, 0, result.stderr);

    const contents = await readFile(
      resolve(fixture, "packages/cloudflare-worker/dist/THIRD_PARTY_LICENSES.txt"),
      "utf8",
    );

    assert.match(contents, /no-license-pkg 4\.0\.0/);
    assert.match(contents, /included files: licenses\/mit\.txt/);
    assert.match(contents, /text source: https:\/\/example\.invalid\/mit/);
    assert.match(contents, /Permission is hereby granted, free of charge/);
    // No copyright holder or year may be asserted for the upstream package.
    assert.match(contents, /Copyright \(c\) <year> <copyright holders>/);
  });

  it("fails closed when a supplement is missing, mismatched, or tampered with", async () => {
    const base = {
      package: "no-license-pkg",
      version: "4.0.0",
      declaredLicense: "MIT",
      licenseFile: "mit.txt",
      sourceUrl: "https://example.invalid/mit",
      sourceSha256: sha256(MIT_TEXT),
      note: "Recorded supplement.",
    };

    const mismatched = await createRepositoryFixture({
      withMissingLicense: true,
      supplement: { ...base, declaredLicense: "Apache-2.0" },
    });
    assert.equal(runGenerator(mismatched).status, 1);

    const wrongVersion = await createRepositoryFixture({
      withMissingLicense: true,
      supplement: { ...base, version: "9.9.9" },
    });
    assert.equal(runGenerator(wrongVersion).status, 1);

    const tampered = await createRepositoryFixture({
      withMissingLicense: true,
      supplement: { ...base, sourceSha256: "0".repeat(64) },
    });
    assert.equal(runGenerator(tampered).status, 1);
  });

  async function createRepositoryFixture(options: {
    withMissingLicense: boolean;
    supplement?: {
      package: string;
      version: string;
      declaredLicense: string;
      licenseFile: string;
      sourceUrl: string;
      sourceSha256: string;
      note: string;
    };
  }): Promise<string> {
    const directory = await mkdtemp(resolve(tmpdir(), "syndroo-licenses-"));
    fixtures.push(directory);
    const packageDirectory = resolve(directory, "packages/cloudflare-worker");

    await writeFile(
      resolve(directory, "package.json"),
      '{"name":"syndroo-license-fixture","version":"0.0.0","private":true}\n',
      "utf8",
    );
    await writeFile(resolve(directory, "wrangler.jsonc"), "{}\n", "utf8");
    await mkdir(resolve(packageDirectory, "dist"), { recursive: true });
    await writeFile(
      resolve(packageDirectory, "package.json"),
      '{"name":"@syndroo/cloudflare-worker","version":"0.0.0"}\n',
      "utf8",
    );
    await writeFile(
      resolve(packageDirectory, "dist/index.js"),
      "export default {};\n",
      "utf8",
    );
    await writeFile(
      resolve(packageDirectory, "dist/index.js.map"),
      `${JSON.stringify({
        version: 3,
        sources: [
          "../../../node_modules/no-field-pkg/index.js",
          "../../../node_modules/mit-pkg/index.js",
          "../../../node_modules/@scope/pkg/index.js",
          ...(options.withMissingLicense
            ? ["../../../node_modules/no-license-pkg/index.js"]
            : []),
        ],
      })}\n`,
      "utf8",
    );

    if (options.supplement !== undefined) {
      await mkdir(resolve(packageDirectory, "licenses"), { recursive: true });
      await writeFile(
        resolve(packageDirectory, "licenses/third-party-license-supplements.json"),
        `${JSON.stringify({ supplements: [options.supplement] }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        resolve(packageDirectory, `licenses/${options.supplement.licenseFile}`),
        MIT_TEXT,
        "utf8",
      );
    }

    await writeInstalledPackage(directory, "mit-pkg", { version: "1.0.0", license: "MIT" }, {
      LICENSE: "MIT License\n\nPermission is hereby granted.\n",
    });
    await writeInstalledPackage(
      directory,
      "no-field-pkg",
      { version: "2.0.0" },
      {
        LICENSE: "Apache License\nVersion 2.0, January 2004\n",
        "NOTICE.txt": "NOTICE of bundled work\n",
      },
    );
    await writeInstalledPackage(directory, "@scope/pkg", { version: "3.0.0", license: "ISC" }, {
      "LICENSE.md": "ISC License\ntext\n",
    });
    await writeInstalledPackage(
      directory,
      "no-license-pkg",
      { version: "4.0.0", license: "MIT" },
      { "README.md": "no license text here\n" },
    );

    return directory;
  }

  async function writeInstalledPackage(
    root: string,
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>,
  ): Promise<void> {
    const directory = resolve(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "package.json"),
      `${JSON.stringify({ name, ...manifest })}\n`,
      "utf8",
    );
    await writeFile(resolve(directory, "index.js"), "export default {};\n", "utf8");

    for (const [fileName, contents] of Object.entries(files)) {
      await writeFile(resolve(directory, fileName), contents, "utf8");
    }
  }

  function runGenerator(fixture: string): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(process.execPath, [GENERATOR], {
      cwd: fixture,
      encoding: "utf8",
    });

    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
});

async function createTree(
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "syndroo-licenses-tree-"));
  temporaryTrees.push(root);

  for (const [name, contents] of Object.entries(files)) {
    const target = resolve(root, name);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  return root;
}

const temporaryTrees: string[] = [];

after(async () => {
  for (const tree of temporaryTrees) {
    await rm(tree, { recursive: true, force: true });
  }
});
