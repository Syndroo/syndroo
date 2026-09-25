# Agent quickstart: local publishing

This is the short path for an agent or automation that drives the `syndroo`
CLI. The bundled skill at `syndroo skill path` carries the same workflow with
more detail; this page is the repo-side summary.

The rule that matters: **a preview is not a publish**. One command freezes a
plan, a second command executes that same plan, and nothing reaches a platform
in between.

## The sequence

```bash
syndroo version
syndroo skill path
syndroo doctor --local
syndroo auth status --local

syndroo publish --input post.json --dry-run --json

# after checking authorization for exactly this content and these accounts
syndroo publish --plan <plan-id> --yes --no-input --json

syndroo receipts show <operation-id> --json
```

1. Confirm the CLI exists and which providers have an active binding. Both
   checks read only; `auth status --local` stays offline unless `--verify` is
   added.
2. Build one strict JSON document with a stable `key` and an explicit
   `platforms` list. There is no default target.
3. Preview it. Read the frozen text, the target accounts, the binding
   revisions, and the frozen business timestamp the CLI prints as a
   diagnostic.
4. If the user already authorized this content, these accounts, and this
   action, continue. Ask only when that authorization does not cover what the
   plan contains.
5. Execute that same plan with `--yes --no-input`. `--yes` records a
   confirmation; it grants no permission.
6. Report every target separately: status, attempts, remote id, and the
   durability of the result.

## Rules an agent must not break

- Never republish to hide a failure. Keep the same key, the same namespace, and
  the same state directory, and read the receipt. A new key, namespace, or
  state directory publishes the same text under a new identity.
- Never retry an `unknown` result blindly. Preview a retry with `--to` and
  select only targets whose failure is provably `not_applied`.
- Never pass post text through a shell. Write the JSON with a serializer or a
  file editor and hand the CLI a path.
- Never put credentials in the conversation, in command arguments, or in a
  screenshot. `auth set` reads the user's environment group or a credential
  file the user manages.
- Never claim a post was published because a preview exited `0`. A preview
  wrote a plan. Only the execution result tells you what each target did, and a
  `partial` run can already have published some targets; report exactly the
  targets the result shows.
- Never switch to the remote HTTP path because the local path failed. The
  remote path is a separate, explicitly chosen surface.

## What to report back

The plan id before execution, then the operation id, the aggregate status, the
durability, and one line per target. Keep three outcomes apart: delivered, not
delivered, and unknown. When a url is `null`, say that no verified link is
known instead of constructing one.

## Limits

The `0.6.0-rc.1` candidate publishes plain text to Bluesky and Threads only, in
the foreground, with no scheduling, media, batch mode, or local OAuth. Provider
maturity is `fixture-tested`; there is no live-account acceptance for this
candidate, and no packaged end-to-end verification yet.

See [cli-manual.md](cli-manual.md) for the full command reference, and the
bundled `references/cli.md`, `references/delivery-semantics.md`, and
`references/http-fallback.md` for the agent-facing detail.
