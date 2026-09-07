import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/i;
const SIGN_OFF = /^Signed-off-by: .+ <[^<>\s]+@[^<>\s]+>$/im;

function requiredSha(name: string): string {
  const value = process.env[name];

  if (value === undefined || !SHA.test(value)) {
    throw new Error(`${name} must contain a full Git commit SHA.`);
  }

  return value;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const base = requiredSha("SYNDROO_BASE_SHA");
const head = requiredSha("SYNDROO_HEAD_SHA");
const commits = git(["rev-list", "--reverse", `${base}..${head}`])
  .split("\n")
  .filter((value) => value.length > 0);

if (commits.length === 0) {
  throw new Error("Pull request contains no commits to check.");
}

const missing = commits.filter((commit) => {
  const message = git(["show", "--no-patch", "--format=%B", commit]);
  return !SIGN_OFF.test(message);
});

if (missing.length > 0) {
  console.error("Every pull-request commit must include a DCO sign-off.");
  for (const commit of missing) {
    console.error(`- ${commit}`);
  }
  console.error("Create commits with `git commit --signoff`.");
  process.exitCode = 1;
} else {
  console.log(`DCO sign-off present on ${String(commits.length)} commit(s).`);
}
