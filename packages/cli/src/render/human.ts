import type {
  ConnectResult,
  ConnectionView,
  DryRunResult,
  ExecutionResult,
  OperationSummary,
  OperationView,
  ProviderView,
  PublishResult,
  StatusResultMap,
  TargetPreview,
} from "@syndroo/core";

import type { Json } from "@syndroo/provider-sdk";

export type RenderOptions = {
  /** Colour already resolved from `--no-color`, `NO_COLOR` and TTY state. */
  readonly color: boolean;
};

/**
 * Escape every control code except tab and newline.
 *
 * Content is escaped before any styling is added, so a preview can carry an
 * exact newline or an exact Unicode string without ever emitting a terminal
 * escape sequence.
 */
export function escapeControls(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (character) => `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`,
  );
}

function styled(enabled: boolean, code: string, text: string): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function jsonText(value: Json): string {
  return escapeControls(JSON.stringify(value) ?? "null");
}

function previewLines(preview: readonly TargetPreview[]): string[] {
  const lines: string[] = [];

  if (preview.length === 0) {
    lines.push("  no targets");
    return lines;
  }

  for (const target of preview) {
    lines.push(
      `  ${escapeControls(target.provider)} -> ${escapeControls(target.connectionId)} ` +
        `(${escapeControls(target.account.accountId)} @ ${escapeControls(target.account.origin)})`,
    );
    const text = target.preview.content.text;
    if (text !== undefined) {
      for (const line of escapeControls(text).split("\n")) {
        lines.push(`      ${line}`);
      }
    }
    for (const field of target.preview.fields) {
      lines.push(`      ${escapeControls(field.name)}: ${jsonText(field.value)}`);
    }
  }

  return lines;
}

function connectionLine(connection: ConnectionView): string {
  const label =
    connection.label === undefined ? "" : ` "${escapeControls(connection.label)}"`;
  const flags = [
    connection.isDefault ? "default" : undefined,
    connection.active ? undefined : "inactive",
  ].filter((value): value is string => value !== undefined);

  return (
    `  ${escapeControls(connection.connectionId)}${label} ` +
    `${escapeControls(connection.account.accountId)} @ ${escapeControls(connection.account.origin)}` +
    (flags.length > 0 ? ` [${flags.join(",")}]` : "")
  );
}

function providerLine(provider: ProviderView): string {
  return (
    `  ${escapeControls(provider.provider)} ${escapeControls(provider.availability)} ` +
    `(${escapeControls(provider.provenance)})`
  );
}

function summaryLine(summary: OperationSummary): string {
  const state =
    summary.phase === "execution"
      ? summary.status ?? "execution"
      : `prepared/${summary.confirmation ?? "required"}`;

  return `  ${escapeControls(summary.operationId)} ${escapeControls(summary.createdAt)} ${escapeControls(state)}`;
}

function deliveryLines(result: ExecutionResult): string[] {
  const lines = result.deliveries.map((delivery) => {
    const outcome = delivery.outcome === null ? "unresolved" : delivery.outcome.status;

    return `  ${escapeControls(delivery.connectionId)} ${escapeControls(outcome)} (attempts ${delivery.attempts})`;
  });

  if (result.durabilityWarning !== undefined) {
    lines.push(`  warning: ${escapeControls(result.durabilityWarning)}`);
  }

  return lines;
}

function operationLines(operation: OperationView): string[] {
  if (operation.phase === "prepared") {
    return [
      `operation ${escapeControls(operation.operationId)} prepared (${escapeControls(operation.confirmation)})`,
      `  expires: ${escapeControls(operation.expiresAt)}`,
      ...previewLines(operation.preview),
    ];
  }

  return [
    `operation ${escapeControls(operation.operationId)} execution ${escapeControls(operation.status)}`,
    ...deliveryLines(operation),
  ];
}

export function renderStatus(
  result: StatusResultMap[keyof StatusResultMap],
  options: RenderOptions,
): string[] {
  switch (result.type) {
    case "overview":
      return [
        styled(options.color, "1", "Syndroo overview"),
        `  initialized: ${result.initialized}`,
        `  connections: ${result.connectionCount}`,
        `  state health: ${escapeControls(result.stateHealth)}`,
        "  providers:",
        ...(result.providers.length > 0
          ? result.providers.map(providerLine)
          : ["  none"]),
        "  recent operations:",
        ...(result.recent.length > 0 ? result.recent.map(summaryLine) : ["  none"]),
      ];
    case "provider":
      return [
        styled(options.color, "1", "Provider"),
        providerLine(result.provider),
        ...(result.provider.implementation
          ? [
              `  package: ${escapeControls(result.provider.implementation.packageName)}`,
              `  version: ${escapeControls(result.provider.implementation.version)}`,
            ]
          : []),
      ];
    case "connections":
      return [
        styled(options.color, "1", "Connections"),
        ...(result.connections.length > 0
          ? result.connections.map(connectionLine)
          : ["  none"]),
      ];
    case "operation":
      return operationLines(result.operation);
    case "operations":
      return [
        styled(options.color, "1", "Operations"),
        ...(result.operations.length > 0
          ? result.operations.map(summaryLine)
          : ["  none"]),
        ...(result.nextCursor === undefined
          ? []
          : [`  next cursor: ${escapeControls(result.nextCursor)}`]),
      ];
  }
}

export function renderConnect(result: ConnectResult, options: RenderOptions): string[] {
  if (result.status === "done") {
    return [
      styled(options.color, "1", "Connection ready"),
      connectionLine(result.connection),
    ];
  }

  const lines = [
    styled(options.color, "1", "Connection action required"),
    `  session: ${escapeControls(result.connectSessionId)}`,
    `  step: ${result.stepRevision}`,
    `  expires: ${escapeControls(result.expiresAt)}`,
  ];

  switch (result.action.type) {
    case "credential_input":
      lines.push("  the provider needs credentials:");
      for (const field of result.action.fields) {
        lines.push(credentialFieldLine(field));
      }
      break;
    case "open_url":
      lines.push(`  open: ${escapeControls(result.action.url)}`);
      break;
    case "wait_for_callback":
      lines.push("  waiting for a provider callback");
      break;
  }

  return lines;
}

/**
 * One credential field, redacted for human display.
 *
 * A field the provider marks secret contributes its label and nothing else:
 * neither the machine field name nor the value is ever printed, so a credential
 * cannot reach a terminal, a log, or an error message through this renderer.
 */
export function credentialFieldLine(field: {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
}): string {
  if (field.secret) {
    return `    ${escapeControls(field.label)} (secret)`;
  }

  return `    ${escapeControls(field.name)}: ${escapeControls(field.label)}`;
}

/** Shell-quote one argument with single quotes, POSIX style. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The ids an execute instruction needs, narrowed from a prepared result. */
export type ExecuteInstructionSource = {
  readonly operationId: string;
  readonly approvalToken: string;
  readonly expiresAt: string;
};

/**
 * The exact machine command that re-runs one prepared intent.
 *
 * The token is the one Core returned in this process's prepared result; it is
 * never read back from disk or from a previous run. The command line is only
 * rendered when both ids match the safe alphabet Core issues, so an unexpected
 * value can never produce a line that behaves differently than it reads.
 */
export function renderExecuteInstruction(
  result: ExecuteInstructionSource,
  lead: string,
): string[] {
  const lines = [
    `  ${escapeControls(lead)}`,
    `  operation: ${escapeControls(result.operationId)}`,
    `  expires: ${escapeControls(result.expiresAt)}`,
  ];
  const safe = /^[A-Za-z0-9._:-]{1,512}$/;

  if (!safe.test(result.operationId) || !safe.test(result.approvalToken)) {
    lines.push("  no execute command is printed for an unexpected token shape.");

    return lines;
  }

  const payload = JSON.stringify({
    type: "execute",
    approvalToken: result.approvalToken,
  });

  lines.push(
    "  to execute this exact frozen intent before it expires, run:",
    `    printf '%s' ${shellQuote(payload)} | syndroo publish --input -`,
  );

  return lines;
}

export function renderPublish(result: PublishResult, options: RenderOptions): string[] {
  if (result.status === "confirmation_required") {
    return [
      styled(options.color, "1", "Confirm this publication"),
      `  operation: ${escapeControls(result.operationId)}`,
      `  expires: ${escapeControls(result.expiresAt)}`,
      "  nothing has been sent yet: this result is only a preview",
      ...previewLines(result.preview),
    ];
  }

  return [
    styled(options.color, "1", "Execution"),
    `  operation: ${escapeControls(result.operationId)}`,
    `  status: ${escapeControls(result.status)}`,
    ...deliveryLines(result),
  ];
}

export function renderExecution(result: ExecutionResult, options: RenderOptions): string[] {
  return [
    styled(options.color, "1", "Execution"),
    `  operation: ${escapeControls(result.operationId)}`,
    `  status: ${escapeControls(result.status)}`,
    ...deliveryLines(result),
  ];
}

export function renderDryRun(result: DryRunResult, options: RenderOptions): string[] {
  return [
    styled(options.color, "1", "Dry run preview"),
    "  no state, credential or network access was used",
    ...previewLines(result.preview),
    ...(result.unverified.length > 0
      ? [`  unverified: ${result.unverified.map(escapeControls).join(", ")}`]
      : []),
  ];
}
