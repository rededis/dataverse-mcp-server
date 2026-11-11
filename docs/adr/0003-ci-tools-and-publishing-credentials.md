# ADR-0003: CI tools run verified bytes; npm publishing has no stored token

- **Status:** Accepted
- **Date:** 2026-11-10
- **Issue:** #121
- **Relates to:** [ADR-0001](0001-local-and-remote-variants.md) §13 (release lines)

## Context

#121 adds [jactionlint](https://github.com/jdx/jactionlint) to CI and fixes
what it reports on the workflows. jactionlint can be installed four ways,
and its own CI guide (`docs/ci.md` in the release archive of v2.5.0) says
which of them verify what they download:

| Method | Pinned by | Download verified by |
|---|---|---|
| Action `jdx/jactionlint` | the action's commit | nothing: it runs a download script that does not check the archive |
| Download script | its version argument | nothing |
| Image `ghcr.io/jdx/jactionlint` | tag or digest | the digest, when pinned |
| mise | `mise.lock` | checksum and provenance in the lock file |

A SHA-pinned action fixes which release is fetched, not the bytes that
arrive. Typos in `ci.yml` (#127) ran from such an action; #157 moved it to
a checked download as well.

jactionlint's first run also flagged `release.yml` (`use-trusted-publishing`): it publishes to npm with a long-lived
`NPM_TOKEN` secret, while the job can already request an OIDC token.

## Decision

### 1. A tool CI downloads is checked against a recorded hash

jactionlint is installed in a `run:` step that downloads the release archive
and checks it with `sha256sum --check` against the digest written in the
workflow, taken from the release's checksums file. Not the action: it
verifies nothing. Not the image: the step would work, but the project does
not use mise or this image anywhere else, and a binary plus a hash is the
smallest thing to read and to update.

The step runs inside the `ci` job, because `ci` is the required check on
`main`: a separate job would not block a merge without changing branch
protection.

Dependabot cannot update a version and digest written in a `run:` step.
They are bumped by hand, together.

A new tool added to CI follows the same rule: an image pinned by digest, a
lock file with checksums, or a hash in the workflow. An action that only
pins a version is not enough.

### 2. npm publishing uses trusted publishing

`release.yml` publishes with npm trusted publishing (OIDC). `id-token: write`
is granted to the publishing job only, the workflow level has no
permissions. npm adds provenance itself.

The trusted publisher on npmjs.com names this repository and the file
`release.yml`. Renaming the file breaks publishing until the setting on
npmjs.com is changed to match.

After the first release published this way, the package is set to disallow
tokens and the npm token secrets are removed from the repository.

## Consequences

- Updating jactionlint or typos (#157) is a manual edit of two values;
  nothing reminds anyone to do it.
- `id-token: write` used to give the publishing job only provenance; now it
  also gives a credential that publishes. Every step of the job can request
  it, `npm ci` and the tests included, until #156 moves the build to a job
  without it.
- A release from a maintenance branch runs that branch's `release.yml`. Each
  `maint/**` branch that may still release needs the trusted-publishing
  `release.yml` before the token is removed.

## Evidence

- jactionlint v2.5.0 release, `docs/ci.md` in its archive: the install
  methods and what each verifies; `docs/cli.md`: online checks run only when
  turned on. <https://github.com/jdx/jactionlint/releases/tag/v2.5.0>
- npm, [Trusted publishing](https://docs.npmjs.com/trusted-publishers):
  npm CLI 11.5.1 or later and Node 22.14.0 or later, `id-token: write`,
  provenance generated automatically when publishing from GitHub Actions.
