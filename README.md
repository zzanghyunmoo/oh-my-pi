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
- `extensions/workspace-connectors`: Linear/Notion MCP connector tools and login commands
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
`full` profile setup.

에이전트가 실행되는 디렉토리(CWD)에 `.env` 파일을 생성하여 익스텐션을 설정합니다:

```bash
# 익스텐션 토글 (opt-in, 명시적으로 true 설정 필요)
ENABLE_QUOTIO=true
ENABLE_WORKSPACE_CONNECTORS=true

# Quotio Provider 설정 (로컬 값은 커밋하지 않음)
QUOTIO_BASE_URL=<local-quotio-openai-compatible-base-url>
QUOTIO_API_KEY=<local-quotio-api-key>
```

- 토글 변수가 없거나 `true`가 아니면 해당 익스텐션은 비활성화됩니다.
- CWD에 `.env`가 없으면 기존 환경변수(`~/.zshrc` 등)만으로 동작합니다.
- CWD `.env`의 값은 기존 `process.env`를 덮어씁니다.

## Commands

- `/oh-my-pi` — Show the oh-my-pi command palette and setup help
- `/oh-my-pi-doctor` — Check local env, capability registry, connector/provider metadata, safety policies, gh auth, and local-only paths
- `/quotio-status` — Check proxy connectivity and authentication
- `/connector-login linear|notion` — OAuth login for workspace connectors
- `/connector-tools linear|notion` — List connector tools after login

## Do not commit

- Pi auth files: `~/.pi/agent/auth.json`
- OAuth state: `.mcp-auth`
- Sessions: `~/.pi/agent/sessions`
- API keys / tokens / `.env`
