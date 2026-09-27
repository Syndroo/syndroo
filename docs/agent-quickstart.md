# Agent quickstart: local publishing

This is the short path for an agent or automation that drives the `syndroo`
CLI. The bundled skill at `syndroo skill path` carries the same workflow with
more detail; this page is the repo-side summary.

The rule that matters: **publish sends; dry-run only previews**. An authorized
agent can publish serialized JSON directly, without a temporary file or a
mandatory preview.

## The sequence

```bash
syndroo version
syndroo skill path
syndroo doctor --local
syndroo auth status --local

# after checking authorization for exactly this content and these accounts
syndroo publish --data '{"key":"agent-post-001","content":"Hello from Syndroo","platforms":["bluesky"]}' --yes --no-input --json

syndroo receipts show <operation-id> --json
```

1. Confirm the CLI exists and which providers have an active binding. Both
   checks read only; `auth status --local` stays offline unless `--verify` is
   added.
2. Build one strict JSON document with a stable `key` and an explicit
   `platforms` list. There is no default target; `schemaVersion` defaults to `1`.
3. Optionally add `--dry-run` to inspect content, target accounts and binding
   revisions. It is read-only, resolves no credentials, and makes no network
   request. It still requires existing config and target bindings.
4. If the user already authorized this content, these accounts, and this
   action, continue. Ask only when that authorization does not cover what the
   input contains.
5. Publish with `--data <json>` and `--yes --no-input`, or use
   `--input post.json` for a reusable file and `--input -` for stdin. Choose one
   source. Confirmation grants no permission. A separate publish reads its
   current input; within that invocation, it confirms and sends one snapshot.
6. Report every target separately: status, attempts, remote id, and the
   durability of the result.

## Rules an agent must not break

- Never republish to hide a failure. Keep the same key, the same namespace, and
  the same state directory, and read the receipt. A new key, namespace, or
  state directory publishes the same text under a new identity.
- Never retry an `unknown` result blindly. Use
  `syndroo retry <operation-id> --to threads --yes --no-input --json` only for
  authorized targets whose failure is provably `not_applied`; add `--dry-run`
  to inspect without retrying.
- Serialize JSON and pass it as one argument, never interpolate generated text
  into a shell command. Inline content may appear in shell history and process
  arguments; prefer stdin for sensitive text. A temporary file is not required.
- Never put credentials in the conversation, in command arguments, or in a
  screenshot. `auth set` reads the user's environment group or a credential
  file the user manages.
- Never include credentials in post JSON.
- Never claim a post was published because a preview exited `0`. A preview
  only validated the input. Only the execution result tells you what each target did, and a
  `partial` run can already have published some targets; report exactly the
  targets the result shows.
- Never switch to the remote HTTP path because the local path failed. The
  remote path is a separate, explicitly chosen surface.

## What to report back

The operation id, the aggregate status, the
durability, and one line per target. Keep three outcomes apart: delivered, not
delivered, and unknown. When a url is `null`, say that no verified link is
known instead of constructing one.

## Limits

The `0.6.0-rc.1` candidate publishes plain text to Bluesky and Threads only, in
the foreground, with no scheduling, media, batch mode, or local OAuth. Provider
maturity is `fixture-tested`; there is no live-account acceptance for this
candidate. Packaged end-to-end checks use fake providers, not live accounts.

See [cli-manual.md](cli-manual.md) for the full command reference, and the
bundled `references/cli.md`, `references/delivery-semantics.md`, and
`references/http-fallback.md` for the agent-facing detail.
