# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Current state of this repo

Of the five, only `wontfix` exists in `rededis/dataverse-mcp-server` today. The other four are created on first use — `gh issue edit --add-label` fails on an unknown label, so create it first:

```
gh label create needs-triage --description "Maintainer needs to evaluate this issue"
```

The repo also carries labels outside this vocabulary — `enhancement`, `documentation`, `epic`, `cowork-remote`, plus the GitHub defaults. They classify subject matter rather than triage state, so they coexist with the five roles rather than competing with them.
