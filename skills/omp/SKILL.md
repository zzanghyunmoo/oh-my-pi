---
name: omp
description: Route oh-my-pi namespace requests. Use when the user writes `omp: <skill-or-command>` or asks to use oh-my-pi as a facade over installed Pi skills, extension commands, tools, providers, or setup workflows.
---

# OMP Namespace

Use this skill when the user invokes the oh-my-pi namespace:

```text
omp: <skill-or-command> [arguments]
```

## Contract

- Treat `omp:` as the user-facing facade owned by `oh-my-pi`.
- Preserve the original package/source mapping for debugging, but do not require
  the user to remember package names during normal use.
- Prefer the matching installed Pi skill or extension command instead of
  reimplementing upstream behavior.
- If a target is unavailable, explain which package/profile capability is
  missing and how to verify it with `omp: doctor`.

## Common skill aliases

| OMP input | Route to |
| --- | --- |
| `omp: plan ...` | `ce-plan` |
| `omp: work ...` | `ce-work` |
| `omp: debug ...` | `ce-debug` |
| `omp: review ...` | `ce-code-review` |
| `omp: brainstorm ...` | `ce-brainstorm` |
| `omp: lsp ...` | `lsp-navigation` |
| `omp: ast ...` | `ast-grep` |
| `omp: ask ...` | `ask-user` |
| `omp: subagents ...` | `pi-subagents` |
| `omp: web ...` | `librarian` |

Exact skill names are also valid: `omp: ce-plan ...`,
`omp: lsp-navigation ...`, `omp: ce-worktree ...`, etc.

## Common command aliases

| OMP input | Route to |
| --- | --- |
| `omp: help` | OMP namespace help |
| `omp: palette` | `/oh-my-pi` command palette |
| `omp: doctor` | `/oh-my-pi-doctor` setup diagnostics |
| `omp: setup full` | `/connector-setup full` setup intent |
| `omp: status` | connector readiness status |
| `omp: quotio-status` | Quotio provider status |
| `omp: connector-login linear` | Linear OAuth connector login |
| `omp: connector-login notion` | Notion OAuth connector login |
| `omp: connector-tools linear` | Linear MCP tool listing |
| `omp: connector-tools notion` | Notion MCP tool listing |
| `omp: github-auth` | GitHub CLI auth status |
| `omp: gitlab-auth` | GitLab CLI auth status |
| `omp: profile-verify` | profile verification guidance |
| `omp: profile-apply` | profile apply dry-run guidance |

## If no direct runtime route exists

1. Identify the intended target after `omp:`.
2. Load the corresponding skill or use the corresponding command/tool.
3. State the original package that owns the behavior when it helps debugging.
4. Keep the answer in OMP vocabulary in user-facing summaries.
