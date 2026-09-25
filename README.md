# Syndroo

Publish plain text to Bluesky and Threads from your own machine, with no
server, queue, or database in the path. Nothing is sent until you preview a
frozen plan and then execute that same plan.

This is the `0.6.0-rc.1` CLI-first candidate. Build and install its local
tarball for validation; live-account acceptance has not been run for it.

## Quickstart

Requirements: Node.js 22 or newer and npm. Local state writes support macOS and
Linux; Windows local writes are refused rather than approximated.

```bash
# build and install the candidate from this repository
npm ci
npm run build          # workspace types must exist in dist before bundling
npm run pack:cli
npm install --global ./artifacts/syndroo-cli-0.6.0-rc.1.tgz
syndroo version

# create local config and state
syndroo init --namespace default
syndroo providers list
syndroo auth set bluesky --local --from-env
syndroo auth status --local
```

`auth set` reads one whole credential group from the environment:
`BLUESKY_IDENTIFIER`, `BLUESKY_PASSWORD`, and optional `BLUESKY_HOST` (which
must be `bsky.social`), or `THREADS_ACCESS_TOKEN`. A credential file works too
and must be a plain file only you can read (`chmod 600`). The CLI never reads
`.env`, never mixes sources, and stores a reference plus a stable account id,
never the secret.

Write one strict JSON document, preview it, then execute that same plan:

```json
{
  "schemaVersion": 1,
  "key": "release-announcement-001",
  "content": "Syndroo now publishes from the command line.",
  "platforms": ["bluesky"]
}
```

```bash
syndroo publish --input post.json --dry-run --json
syndroo publish --plan <plan-id> --yes --no-input --json
syndroo receipts show <operation-id> --json
```

The preview writes a signed plan and makes no platform request. Execution takes
the local write lock and sends at most one content request per target. Exit `0`
on a preview means the plan was written; only a full success means everything
was published. An `unknown` outcome stops blind retries, so read the receipt
instead of re-sending.

Full command reference: [docs/cli-manual.md](docs/cli-manual.md). Agent
quickstart: [docs/agent-quickstart.md](docs/agent-quickstart.md). The bundled
Skill lives at `syndroo skill path`.

## Development

```bash
npm ci
export SYNDROO_RELEASE_SET=cli
npm test
npm run check
npm run e2e:cli-local          # packed CLI, isolated install, fake providers
npm run verify:package
```

[docs/testing.md](docs/testing.md) describes what each layer proves;
[docs/releasing.md](docs/releasing.md) covers the release sets and what remains
unverified.

## Contributing and licence

Contributions require a Developer Certificate of Origin sign-off; see
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Domain vocabulary
is in [CONTEXT.md](CONTEXT.md).

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Grant Dai.
