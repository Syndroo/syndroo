/**
 * The release version rules shared by every release checker.
 *
 * A version's shape alone decides its npm dist-tag. There is deliberately no
 * override: a `-rc.<n>` candidate can only ever publish under `next`, so no
 * flag, environment variable, or workflow input can retag a candidate as
 * `latest` and call it a stable release.
 */

export const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const CANDIDATE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/;

export type DistTag = "latest" | "next";

export type ReleaseChannel = {
  readonly distTag: DistTag;
  readonly prerelease: boolean;
};

export type ReleaseStage = "rc" | "final";

export function versionShapeError(version: string): string {
  return `Package version ${JSON.stringify(version)} must be <major>.<minor>.<patch> or <major>.<minor>.<patch>-rc.<n>.`;
}

/**
 * Stable versions publish under `latest`; `-rc.<n>` candidates publish under
 * `next`. The release workflow always passes this value through as an explicit
 * `npm publish --tag`, because npm requires one for prerelease versions.
 */
export function classifyVersion(version: string): ReleaseChannel {
  if (STABLE_VERSION.test(version)) {
    return { distTag: "latest", prerelease: false };
  }

  if (CANDIDATE_VERSION.test(version)) {
    return { distTag: "next", prerelease: true };
  }

  throw new Error(versionShapeError(version));
}

export function releaseStage(channel: ReleaseChannel): ReleaseStage {
  return channel.prerelease ? "rc" : "final";
}
