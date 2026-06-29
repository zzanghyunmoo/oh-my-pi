# oh-my-pi

Personal Pi package for sharing my Pi extensions, prompt templates, and themes across machines.

## Install

```bash
pi install git:github.com/zzanghyunmoo/oh-my-pi
```

For SSH/private repo:

```bash
pi install git:git@github.com:zzanghyunmoo/oh-my-pi
```

## Contains

- `extensions/env-loader`: CWD `.env` 로더 (다른 익스텐션보다 먼저 환경변수 로딩)
- `extensions/workspace-connectors`: Linear/Notion MCP connector tools, read-only GitHub/GitLab CLI bridges, and connector login/status/logout commands
- `extensions/quotio-provider`: Quotio LiteLLM proxy provider (OpenAI-compatible, dynamic model discovery)
- `extensions/setup-doctor`: read-only setup doctor and command palette
- `docs/profiles`: commit-safe profile pack and deterministic profile lock receipt

## Setup

See `docs/blueprints/secret-references.md` for the versioned, secret-free blueprint
that separates committed intent from local-only values.

Profiles are described in `docs/profiles/*.profile.json`. Verify the committed
profile lock before recreating a machine:

```bash
npm run profile:verify
npm run profile:apply -- --profile full   # dry-run only; prints install/.env/login intent
```

`profile:apply` does not run `pi install`, write `.env`, or start OAuth by default.
Use its output as a safe checklist for `default`, `workspace`, `proxy-provider`, or
`full` profile setup. Connector setup intent is then selected inside Pi with
`/connector-setup full`, `/connector-setup selective ...`, or `/connector-setup minimal`.

에이전트가 실행되는 디렉토리(CWD)에 `.env` 파일을 생성하여 익스텐션을 설정합니다:

```bash
# 익스텐션 토글 (opt-in, 명시적으로 true 설정 필요)
ENABLE_QUOTIO=true
ENABLE_WORKSPACE_CONNECTORS=true

# Workspace connector access-key fallback (브라우저 OAuth가 불가할 때만 사용, 커밋하지 않음)
LINEAR_API_KEY=<local-linear-api-key>
NOTION_API_KEY=<local-notion-integration-token>
# 또는 NOTION_TOKEN=<local-notion-integration-token>

# Optional company GitLab host selector for glab-based reads (token은 glab가 관리)
GITLAB_HOST=<company-gitlab-host>

# Quotio Provider 설정 (로컬 값은 커밋하지 않음)
QUOTIO_BASE_URL=<local-quotio-openai-compatible-base-url>
QUOTIO_API_KEY=<local-quotio-api-key>
```

- 토글 변수가 없거나 `true`가 아니면 해당 익스텐션은 비활성화됩니다.
- CWD에 `.env`가 없으면 기존 환경변수(`~/.zshrc` 등)만으로 동작합니다.
- CWD `.env`의 값은 기존 `process.env`를 덮어씁니다.

## Commands

- `/connector-setup full` — Select the full connector surface: personal Linear/Notion/GitHub plus company Jira/Confluence/GitLab readiness.
- `/connector-setup selective tenant:company capability:git` — Select connector intent by tenant/capability; use `service:linear service:notion` for explicit services.
- `/connector-setup minimal` — Intentionally hide issue-tracker, wiki, and git connector affordances.
- `/oh-my-pi` — Show the oh-my-pi command palette and setup help.
- `/oh-my-pi-doctor` — Check local env, capability registry, connector/provider metadata, safety policies, gh/glab auth, connector readiness, and local-only paths.
- `/quotio-status` — Check proxy connectivity and authentication.
- `/connector-login linear|notion` — Direct browser OAuth login for OAuth MCP workspace connectors.
- `/connector-status [service]` — Show connector setup readiness plus OAuth/access-key status.
- `/connector-logout <service|tenant:personal|tenant:company|capability:git> [--confirm]` — Preview first; clears only Pi-managed OAuth state when confirmed.
- `/connector-tools linear|notion` — List connector tools after OAuth login or access-key env setup.

`/connector-login` opens the browser directly and receives the OAuth callback on
`127.0.0.1`. It no longer pauses the Pi TUI or runs `mcp-remote-client` inside
the terminal. OAuth tokens are stored outside the repo at
`~/.pi/agent/workspace-connectors-auth.json` by default. Connector setup mode is
stored separately at `~/.pi/agent/workspace-connectors-setup.json` by default.
Override those local-only paths with `OH_MY_PI_CONNECTOR_AUTH_PATH` and
`OH_MY_PI_CONNECTOR_SETUP_PATH` when needed.

If browser OAuth is unavailable, set `LINEAR_API_KEY` or
`NOTION_API_KEY`/`NOTION_TOKEN` in the CWD `.env`. Connector tools prefer stored
OAuth tokens and then fall back to the configured access key.

GitHub uses the authenticated `gh` CLI through a fail-closed read-only allowlist.
GitLab uses the authenticated `glab` CLI the same way; oh-my-pi never stores
GitLab tokens. Jira and Confluence are setup-visible company capabilities, but
runtime tools stay gated until a non-interactive Atlassian auth route is selected.

## Do not commit

- Pi auth files: `~/.pi/agent/auth.json`
- OAuth state: `.mcp-auth`, `~/.pi/agent/workspace-connectors-auth.json`
- Connector setup state: `~/.pi/agent/workspace-connectors-setup.json`
- Sessions: `~/.pi/agent/sessions`
- API keys / tokens / `.env`
