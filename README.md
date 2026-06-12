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

- `extensions/workspace-connectors`: Linear/Notion MCP connector tools and login commands
- `extensions/quotio-provider`: Quotio LiteLLM proxy provider (OpenAI-compatible, dynamic model discovery)

## Quotio Provider Setup

Set the following environment variables (or add to `.env` in the package root):

```bash
QUOTIO_BASE_URL=http://127.0.0.1:8317/v1
QUOTIO_API_KEY=your-quotio-api-key
```

Commands:
- `/quotio-status` — Check proxy connectivity and authentication

## Do not commit

- Pi auth files: `~/.pi/agent/auth.json`
- OAuth state: `.mcp-auth`
- Sessions: `~/.pi/agent/sessions`
- API keys / tokens / `.env`
