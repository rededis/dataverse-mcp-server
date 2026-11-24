# CLAUDE.md

MCP server exposing Microsoft Dataverse (Dynamics 365) to Claude over stdio.
Published to npm as `@rededis/dataverse-mcp-server`.

## Public repository

This repository is public. Everything posted to GitHub — issues, PR descriptions, review comments, thread replies, commit messages — is readable by anyone and stays indexed after deletion. Never put Dataverse data there: record contents, org or environment URLs, tenant and client IDs, user names, emails or IDs, names of tables and records from a real org, tokens, log excerpts with any of these. Write "a test table in the dev org", "a contact", "the application user" instead. Check drafts for this before publishing them. Write everything posted to GitHub in English, the language of this repository.

## Tool descriptions

A tool's description and its fields' `.describe()` texts are the contract the agent reads. When you change what a tool does, rewrite every text that describes it in the same change: its description, its fields, other tools' descriptions that name it (`grep -rn '<tool_name>' src/tools`) and its line in the README table. A sentence that describes a limitation an open issue will remove carries a `// Remove … when #NN lands.` comment above it; the change that closes #NN deletes the sentence.

## Agent skills

### Issue tracker

GitHub Issues in `rededis/dataverse-mcp-server`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label named after its role. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
