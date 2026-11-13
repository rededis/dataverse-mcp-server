import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The pre-push hook (#167) against a real git push to a local bare
// repository. Betterleaks itself is replaced by a stub that records what it
// was given: the tests cover which commits the hook hands over and what it
// does with the result, not the rules, which CI runs for real.

// Without the directories a package manager installs into: a betterleaks
// installed on this machine must not answer for the stub.
const SYSTEM_PATH = "/usr/bin:/bin";

const STUB = `#!/bin/sh
# Stands in for betterleaks: appends its arguments and, for the stdin scan,
# its input to $STUB_LOG, and exits with $STUB_EXIT.
echo "args: $*" >> "$STUB_LOG"
for arg in "$@"; do
  [ "$arg" = stdin ] && cat >> "$STUB_LOG"
done
exit "\${STUB_EXIT:-0}"
`;

let root: string;
let work: string;
let stubDir: string;
let log: string;

/**
 * Runs git with an environment of its own, in the work tree unless `cwd` says
 * otherwise. Nothing is inherited: under the pre-commit hook this test runs
 * with GIT_DIR pointing at the real repository, and git would act on that.
 */
function git(
  args: string[],
  {
    stub = true,
    exit = "0",
    cwd = work,
  }: { stub?: boolean; exit?: string; cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    env: {
      PATH: stub ? `${stubDir}:${SYSTEM_PATH}` : SYSTEM_PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      STUB_LOG: log,
      STUB_EXIT: exit,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** An empty commit; returns its sha. */
function commit(message: string): string {
  git(["commit", "--allow-empty", "-m", message]);
  return git(["rev-parse", "HEAD"]).stdout.trim();
}

/** The branches of the bare repository. */
function remoteBranches(): string[] {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: join(root, "remote.git"),
  })
    .stdout.split("\n")
    .filter(Boolean);
}

/** What the stub recorded, or "" when it never ran. */
function stubLog(): string {
  try {
    return readFileSync(log, "utf8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pre-push-"));
  work = join(root, "work");
  stubDir = join(root, "bin");
  log = join(root, "stub.log");

  mkdirSync(stubDir);
  writeFileSync(join(stubDir, "betterleaks"), STUB);
  chmodSync(join(stubDir, "betterleaks"), 0o755);

  git(["init", "--quiet", "--bare", join(root, "remote.git")], { cwd: root });
  git(["init", "--quiet", "--initial-branch=main", work], { cwd: root });
  // The hook and the script it calls, as the repository has them.
  mkdirSync(join(work, "hooks"));
  cpSync(".husky/pre-push", join(work, "hooks/pre-push"));
  mkdirSync(join(work, "scripts"));
  cpSync("scripts/scan-commits.sh", join(work, "scripts/scan-commits.sh"));
  cpSync(".betterleaks.toml", join(work, ".betterleaks.toml"));
  for (const setting of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["core.hooksPath", "hooks"],
  ]) {
    git(["config", ...setting]);
  }
  git(["remote", "add", "origin", join(root, "remote.git")]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pre-push hook", () => {
  it("refuses the push when the scan fails", () => {
    commit("first");

    const push = git(["push", "origin", "main"], { exit: "1" });

    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain("pre-push: the push is refused");
    expect(remoteBranches()).toEqual([]);
  });

  it("lets the push through when the scan passes", () => {
    commit("first");

    expect(git(["push", "origin", "main"]).status).toBe(0);
    expect(remoteBranches()).toEqual(["main"]);
    // Both scans ran, with the project rules.
    expect(stubLog()).toMatch(/args: --config \.betterleaks\.toml .* git \./);
    expect(stubLog()).toMatch(/args: --config \.betterleaks\.toml .* stdin/);
  });

  it("scans every commit of a new branch the remote does not have", () => {
    const first = commit("first");
    git(["push", "origin", "main"]);
    rmSync(log);
    git(["switch", "--quiet", "-c", "feature"]);
    const second = commit("second");
    const third = commit("third");

    git(["push", "origin", "feature"]);

    expect(stubLog()).toContain(`commit ${second}`);
    expect(stubLog()).toContain(`commit ${third}`);
    expect(stubLog()).not.toContain(`commit ${first}`);
  });

  it("scans only the new commits of a branch the remote has", () => {
    const first = commit("first");
    git(["push", "origin", "main"]);
    rmSync(log);
    const second = commit("second");

    git(["push", "origin", "main"]);

    expect(stubLog()).toContain(`commit ${second}`);
    expect(stubLog()).not.toContain(`commit ${first}`);
  });

  it("scans each branch of one push", () => {
    commit("first");
    git(["push", "origin", "main"]);
    rmSync(log);
    git(["switch", "--quiet", "-c", "one"]);
    const one = commit("one");
    git(["switch", "--quiet", "-c", "two", "main"]);
    const two = commit("two");

    git(["push", "origin", "one", "two"]);

    expect(stubLog()).toContain(`commit ${one}`);
    expect(stubLog()).toContain(`commit ${two}`);
  });

  it("does not scan a branch deletion", () => {
    commit("first");
    git(["push", "origin", "main"]);
    git(["push", "origin", "main:gone"]);
    rmSync(log);

    expect(
      git(["push", "origin", "--delete", "gone"], { exit: "1" }).status,
    ).toBe(0);
    expect(stubLog()).toBe("");
    expect(remoteBranches()).toEqual(["main"]);
  });

  it("lets the push through with a warning when betterleaks is missing", () => {
    commit("first");

    const push = git(["push", "origin", "main"], { stub: false });

    expect(push.status).toBe(0);
    expect(push.stderr).toContain("pre-push: betterleaks is not installed");
    expect(remoteBranches()).toEqual(["main"]);
  });
});
