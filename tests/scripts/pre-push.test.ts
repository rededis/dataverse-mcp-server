import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The pre-push hook (#167) against a real git push to a local bare
// repository. Betterleaks itself is replaced by a stub that records what it
// was given: the tests cover which commits the hook hands over and what it
// does with the result, not the rules, which CI runs for real.

const REPO = resolve(__dirname, "../..");

// What the hook and the script run, besides betterleaks. The tests give git
// a PATH with these alone, each as a wrapper around the one found on this
// machine: wherever they are installed, and whatever else is installed next
// to them, the stub or its absence is what the hook finds.
const TOOLS = ["git", "sh", "bash", "cat"];

/** The absolute path of a command on this process's PATH. */
function locate(command: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (dir && existsSync(candidate)) return candidate;
  }
  throw new Error(`${command} is not on PATH`);
}

const STUB = `#!/bin/sh
# Stands in for betterleaks: appends its arguments and, for the stdin scan,
# its input to $STUB_LOG. Exits 1 for the scan named in $STUB_FAILS (git,
# stdin or both).
echo "args: $*" >> "$STUB_LOG"
scan=git
for arg in "$@"; do
  [ "$arg" = stdin ] && scan=stdin && cat >> "$STUB_LOG"
done
case "$STUB_FAILS" in
  "$scan" | both) exit 1 ;;
esac
exit 0
`;

type Scan = "git" | "stdin" | "both" | "none";

let tmp: string;
let work: string;
let toolsDir: string;
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
    betterleaksInstalled = true,
    failingScan = "none",
    cwd = work,
  }: { betterleaksInstalled?: boolean; failingScan?: Scan; cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(join(toolsDir, "git"), args, {
    cwd,
    env: {
      PATH: betterleaksInstalled ? `${stubDir}:${toolsDir}` : toolsDir,
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      STUB_LOG: log,
      STUB_FAILS: failingScan,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** git for the steps a test only prepares with: a failure stops the test. */
function mustGit(args: string[], cwd = work): string {
  const { status, stdout, stderr } = git(args, { cwd });
  if (status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${status}): ${stderr}`);
  }
  return stdout;
}

/** An empty commit; returns its sha. */
function commit(message: string): string {
  mustGit(["commit", "--allow-empty", "-m", message]);
  return mustGit(["rev-parse", "HEAD"]).trim();
}

/**
 * A first commit on main, pushed, and the stub's record of that push thrown
 * away; returns the commit's sha.
 */
function pushedMain(): string {
  const first = commit("first");
  mustGit(["push", "origin", "main"]);
  rmSync(log);
  return first;
}

/** The branches of the bare repository. */
function remoteBranches(): string[] {
  return mustGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    join(tmp, "remote.git"),
  )
    .split("\n")
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

/** The stub's argument lines for the commit diff scan. */
function diffScans(): string[] {
  return stubLog()
    .split("\n")
    .filter((line) => line.startsWith("args: ") && line.includes(" git . "));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dataverse-mcp-pre-push-"));
  work = join(tmp, "work");
  toolsDir = join(tmp, "tools");
  stubDir = join(tmp, "bin");
  log = join(tmp, "stub.log");

  mkdirSync(toolsDir);
  for (const tool of TOOLS) {
    writeFileSync(
      join(toolsDir, tool),
      `#!/bin/sh\nexec "${locate(tool)}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, "betterleaks"), STUB);
  chmodSync(join(stubDir, "betterleaks"), 0o755);

  mustGit(["init", "--quiet", "--bare", join(tmp, "remote.git")], tmp);
  mustGit(["init", "--quiet", "--initial-branch=main", work], tmp);
  // The hook and the script it calls, as the repository has them. Here git
  // runs the hook itself, not through husky's wrapper, so the copy must be
  // executable whatever mode the file is committed with.
  mkdirSync(join(work, "hooks"));
  cpSync(join(REPO, ".husky/pre-push"), join(work, "hooks/pre-push"));
  chmodSync(join(work, "hooks/pre-push"), 0o755);
  mkdirSync(join(work, "scripts"));
  cpSync(
    join(REPO, "scripts/scan-commits.sh"),
    join(work, "scripts/scan-commits.sh"),
  );
  cpSync(join(REPO, ".betterleaks.toml"), join(work, ".betterleaks.toml"));
  for (const setting of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["core.hooksPath", "hooks"],
  ]) {
    mustGit(["config", ...setting]);
  }
  mustGit(["remote", "add", "origin", join(tmp, "remote.git")]);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// The hook is a POSIX shell script; git for Windows brings its own sh, which
// these tests do not look for.
describe.skipIf(process.platform === "win32")("pre-push hook", () => {
  // Each scan on its own: a finding in a diff, or in a message, is enough.
  for (const failingScan of ["git", "stdin"] as const) {
    it(`refuses the push when the ${failingScan} scan fails`, () => {
      commit("first");

      const push = git(["push", "origin", "main"], { failingScan });

      expect(push.status).not.toBe(0);
      expect(push.stderr).toContain("pre-push: the push is refused");
      expect(remoteBranches()).toEqual([]);
      // The other scan still ran.
      expect(stubLog()).toMatch(/args: .* git \./);
      expect(stubLog()).toMatch(/args: .* stdin/);
    });
  }

  it("lets the push through when the scans pass", () => {
    commit("first");

    expect(git(["push", "origin", "main"]).status).toBe(0);
    expect(remoteBranches()).toEqual(["main"]);
    // Both scans ran, with the project rules.
    expect(stubLog()).toMatch(/args: --config \.betterleaks\.toml .* git \./);
    expect(stubLog()).toMatch(/args: --config \.betterleaks\.toml .* stdin/);
  });

  it("scans every commit of a new branch the remote does not have", () => {
    const first = pushedMain();
    mustGit(["switch", "--quiet", "-c", "feature"]);
    const second = commit("second");
    const third = commit("third");

    expect(git(["push", "origin", "feature"]).status).toBe(0);

    // The messages, by the commits git log printed for the stdin scan.
    expect(stubLog()).toContain(`commit ${second}`);
    expect(stubLog()).toContain(`commit ${third}`);
    expect(stubLog()).not.toContain(`commit ${first}`);
    // The diffs, by the revisions handed to the git scan.
    expect(diffScans()).toEqual([
      expect.stringContaining(
        `--log-opts=--diff-merges=first-parent ${third} --not --remotes=origin`,
      ),
    ]);
  });

  it("scans only the new commits of a branch the remote has", () => {
    const first = pushedMain();
    const second = commit("second");

    expect(git(["push", "origin", "main"]).status).toBe(0);

    expect(stubLog()).toContain(`commit ${second}`);
    expect(stubLog()).not.toContain(`commit ${first}`);
    expect(diffScans()).toEqual([
      expect.stringContaining(
        `--log-opts=--diff-merges=first-parent ${second} --not --remotes=origin`,
      ),
    ]);
  });

  it("scans every branch of one push, in one scan", () => {
    pushedMain();
    mustGit(["switch", "--quiet", "-c", "one"]);
    const one = commit("one");
    mustGit(["switch", "--quiet", "-c", "two", "main"]);
    const two = commit("two");

    expect(git(["push", "origin", "one", "two"]).status).toBe(0);

    expect(stubLog()).toContain(`commit ${one}`);
    expect(stubLog()).toContain(`commit ${two}`);
    expect(diffScans()).toEqual([
      expect.stringContaining(
        `--log-opts=--diff-merges=first-parent ${one} ${two} --not --remotes=origin`,
      ),
    ]);
  });

  it("reads the sha of a ref typed with spaces in it", () => {
    pushedMain();
    const second = commit("second");

    expect(
      git(["push", "origin", "HEAD@{0 minutes ago}:refs/heads/typed"]).status,
    ).toBe(0);

    expect(stubLog()).toContain(`commit ${second}`);
    expect(diffScans()).toEqual([
      expect.stringContaining(` ${second} --not --remotes=origin`),
    ]);
  });

  it("does not scan a branch deletion", () => {
    pushedMain();
    mustGit(["push", "origin", "main:gone"]);
    rmSync(log);

    expect(
      git(["push", "origin", "--delete", "gone"], { failingScan: "both" })
        .status,
    ).toBe(0);
    expect(stubLog()).toBe("");
    expect(remoteBranches()).toEqual(["main"]);
  });

  it("lets the push through with a warning when betterleaks is missing", () => {
    commit("first");

    const push = git(["push", "origin", "main"], {
      betterleaksInstalled: false,
    });

    expect(push.status).toBe(0);
    expect(push.stderr).toContain("pre-push: betterleaks is not on PATH");
    expect(remoteBranches()).toEqual(["main"]);
  });
});
