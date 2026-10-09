/**
 * Redirect-URI and callback-URL shaping for the local OAuth adapter.
 *
 * The adapter receives an authorization redirect on one of two paths, chosen
 * by the redirect URI the caller registers with the platform:
 *
 * - a **loopback** URI (`127.0.0.1`, `[::1]` or `localhost`) is served by a
 *   listener this process binds itself, on exactly the host, port and path of
 *   that URI;
 * - any other URI is not bound at all: the CLI prints the authorization URL and
 *   accepts the redirected URL that the user pastes back.
 *
 * Nothing here performs I/O or reads a clock; every value is derived from its
 * argument so the shapes can be asserted directly.
 */

import { OAuthError } from "./errors.js";

/** Loopback host literals this adapter will bind a listener to. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

/** The default port of the pre-registerable loopback redirect. */
export const DEFAULT_LOOPBACK_PORT = 8765;

/** The default callback path, suffixed with the provider id. */
export const CALLBACK_PATH_PREFIX = "/oauth/callback/";

export type LoopbackTarget = {
  readonly kind: "loopback";
  /** The exact redirect URI offered to the provider. */
  readonly uri: string;
  /** The host to bind: always a loopback literal, never `0.0.0.0` or `::`. */
  readonly host: string;
  readonly port: number;
  /** The exact path the listener answers; any other path is refused. */
  readonly path: string;
};

export type RemoteTarget = {
  readonly kind: "remote";
  readonly uri: string;
  readonly hostname: string;
};

export type RedirectTarget = LoopbackTarget | RemoteTarget;

/** Provider ids that may appear in the default callback path. */
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** Strip the brackets a URL keeps around an IPv6 literal. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

/**
 * The pre-registerable loopback redirect for one provider.
 *
 * The provider is part of the path, so one registered redirect covers exactly
 * one provider; the port is fixed so an OAuth app can be registered once.
 */
export function defaultRedirectUri(provider: string, port = DEFAULT_LOOPBACK_PORT): string {
  if (!PROVIDER_ID.test(provider)) {
    throw new OAuthError("PROVIDER_ID_INVALID");
  }

  return `http://127.0.0.1:${port}${CALLBACK_PATH_PREFIX}${provider}`;
}

/**
 * Classify one redirect URI. Throws a static code on anything a listener or a
 * paste path could not handle exactly.
 *
 * A loopback URI must name an explicit port: a listener cannot bind "the
 * default port of some scheme" and still be pre-registerable.
 */
export function parseRedirectUri(value: string): RedirectTarget {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("REDIRECT_URI_INVALID");
  }

  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new OAuthError("REDIRECT_URI_INVALID");
  }

  if (url.pathname === "" || url.pathname === "/" || !url.pathname.startsWith("/")) {
    throw new OAuthError("REDIRECT_URI_INVALID");
  }

  const host = bareHost(url.hostname);

  if (host === "") {
    throw new OAuthError("REDIRECT_URI_INVALID");
  }

  const loopback = (LOOPBACK_HOSTS as readonly string[]).includes(host);

  if (!loopback) {
    // A non-loopback redirect is served by someone else's HTTPS endpoint; a
    // plaintext one would carry the authorization code in the clear.
    if (url.protocol !== "https:") {
      throw new OAuthError("REDIRECT_URI_INVALID");
    }

    return { kind: "remote", uri: url.toString(), hostname: host };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OAuthError("REDIRECT_URI_INVALID");
  }

  if (url.port === "") {
    throw new OAuthError("REDIRECT_URI_INVALID");
  }

  const port = Number.parseInt(url.port, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new OAuthError("REDIRECT_URI_INVALID");
  }

  return { kind: "loopback", uri: url.toString(), host, port, path: url.pathname };
}

/**
 * The request target of one redirect the browser sent back.
 *
 * Only the path and query matter for verification; the fragment is never sent
 * to a server, and anything that looks like a different shape is refused here
 * before the adapter sees it.
 */
export function parseCallbackUrl(value: string): URL {
  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > 8_192 || /\s/.test(trimmed)) {
    throw new OAuthError("CALLBACK_URL_INVALID");
  }

  try {
    return new URL(trimmed);
  } catch {
    throw new OAuthError("CALLBACK_URL_INVALID");
  }
}
