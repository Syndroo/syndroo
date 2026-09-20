import { configError } from "./cli-error.js";

/** The only two variables the CLI reads. There is no config file and no `.env` support. */
export const BASE_URL_ENV = "SYNDROO_BASE_URL";
export const API_KEY_ENV = "SYNDROO_API_KEY";

export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly baseUrlSource: string;
  readonly apiKeySource: string;
}

/** Doctor output: presence and provenance only. The key value never leaves this module. */
export interface ConfigInspection {
  readonly baseUrl: string | undefined;
  readonly baseUrlSource: string | undefined;
  readonly apiKeyConfigured: boolean;
  readonly apiKeySource: string | undefined;
  readonly problems: readonly string[];
}

export function inspectConfig(
  env: NodeJS.ProcessEnv,
  overrides: { baseUrl?: string | undefined } = {},
): ConfigInspection {
  const flagBaseUrl = overrides.baseUrl;
  const envBaseUrl = clean(env[BASE_URL_ENV]);
  const baseUrl = flagBaseUrl ?? envBaseUrl;
  const baseUrlSource =
    flagBaseUrl !== undefined
      ? "--base-url"
      : envBaseUrl !== undefined
        ? BASE_URL_ENV
        : undefined;
  const apiKey = clean(env[API_KEY_ENV]);
  const problems: string[] = [];

  if (baseUrl === undefined) {
    problems.push(
      `${BASE_URL_ENV} is not set, so the CLI has no Syndroo instance to talk to.`,
    );
  } else if (!isHttpUrl(baseUrl)) {
    problems.push(`${baseUrlSource} is not an absolute http(s) URL.`);
  }

  if (apiKey === undefined) {
    problems.push(`${API_KEY_ENV} is not set, so the CLI cannot authenticate.`);
  }

  return {
    baseUrl,
    baseUrlSource,
    apiKeyConfigured: apiKey !== undefined,
    apiKeySource: apiKey === undefined ? undefined : API_KEY_ENV,
    problems,
  };
}

export function resolveConfig(
  env: NodeJS.ProcessEnv,
  overrides: { baseUrl?: string | undefined } = {},
): ResolvedConfig {
  const inspection = inspectConfig(env, overrides);
  const apiKey = clean(env[API_KEY_ENV]);

  if (inspection.problems.length > 0) {
    throw configError(inspection.problems.join(" "), {
      baseUrlSource: inspection.baseUrlSource ?? null,
      apiKeyConfigured: inspection.apiKeyConfigured,
    });
  }

  return {
    baseUrl: inspection.baseUrl as string,
    apiKey: apiKey as string,
    baseUrlSource: inspection.baseUrlSource as string,
    apiKeySource: API_KEY_ENV,
  };
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
