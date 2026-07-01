# AGENTS.md — oh-my-pi 프로젝트 가드레일

Pi coding agent 개인 확장 패키지.

## 프로젝트 구조

```
oh-my-pi/
├── extensions/
│   ├── env-loader/             # CWD .env 로더 (가장 먼저 로드)
│   ├── workspace-connectors/   # Linear/Notion MCP 커넥터
│   └── quotio-provider/        # Quotio LiteLLM proxy provider
├── docs/
│   ├── brainstorms/            # ce-brainstorm 결과물
│   ├── plans/                  # ce-plan 결과물
│   ├── ideation/               # ce-ideate 결과물
│   └── solutions/              # 문서화된 패턴/컨벤션 (category별, YAML frontmatter로 검색 가능)
├── CONCEPTS.md                 # 공유 도메인 어휘 (엔티티, 프로세스, 상태 개념)
├── package.json                # Pi 패키지 설정
└── README.md
```

## 지식 저장소

- `docs/solutions/`는 과거 문제 해결, 버그, 패턴, 워크플로 지식을 category와 YAML frontmatter(`module`, `tags`, `problem_type`)로 검색할 수 있는 저장소다. 구현, 디버깅, 구조 결정 시 관련 영역의 선례를 찾는 데 유용하다.
- `CONCEPTS.md`는 프로젝트 고유 용어를 정의하는 공유 어휘집이다. connector, provider, profile, safety policy 같은 도메인 개념을 논의하거나 문서화할 때 참고한다.

## Extension 개발 규칙

- 진입점: `export default function(pi: ExtensionAPI)` 패턴
- 도구 등록: `pi.registerTool({ name, parameters: Type.Object(...), execute })`
- 커맨드 등록: `pi.registerCommand(name, { description, handler })`
- 프로바이더 등록: `pi.registerProvider(name, config)` — 실제 resolve된 값을 전달 (`$ENV_VAR` 리터럴은 동작하지 않음)
- 이벤트 훅: `pi.on("session_start", async (_event, ctx) => { ... })`
- 사용자 피드백: `ctx.ui.notify(message, "info" | "error")`
- **토글 패턴**: 각 익스텐션의 factory 최상단에서 `if (process.env.ENABLE_* !== "true") return;` 으로 opt-in 활성화

## 환경변수 관리

- CWD `.env`가 환경변수 소스 (패키지 루트 `.env`는 사용하지 않음)
- CWD `.env`의 값은 기존 `process.env`를 덮어씀 (override 모드)
- 토글 변수와 실제 값을 하나의 `.env`에서 관리
- `env-loader` 익스텐션이 가장 먼저 로드되어 다른 익스텐션보다 앞서 환경변수 세팅

## 커밋 금지 항목

- `.env` (API key, 프록시 URL, 토글 변수)
- `node_modules/`
- `~/.pi/agent/auth.json`
- `.mcp-auth/`

## 의존성

- `@earendil-works/pi-coding-agent` — Pi ExtensionAPI 타입
- `@modelcontextprotocol/sdk` — MCP 클라이언트 (workspace-connectors용)
- TypeScript ^6.0.3, Node.js ESM (`"type": "module"`)
