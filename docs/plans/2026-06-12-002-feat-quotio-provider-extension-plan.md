---
title: "feat: Add Quotio Proxy Provider Extension"
type: feat
status: active
date: 2026-06-12
origin: docs/brainstorms/2026-06-12-quotio-provider-requirements.md
---

# feat: Add Quotio Proxy Provider Extension

## Summary

oh-my-pi의 `extensions/quotio-provider/`에 새 확장을 생성하여 quotio 프록시의 Anthropic Messages API 경로에 연결하는 커스텀 프로바이더를 등록한다. 기존 `workspace-connectors` 확장의 구조와 패턴(export default, registerCommand, session_start hook)을 따르며, 환경변수 검증과 `/quotio-status` 진단 커맨드를 포함한다.

---

## Requirements

- R1. `extensions/quotio-provider/index.ts`에서 `pi.registerProvider("quotio", config)`를 호출하여 프로바이더를 등록한다.
- R2. `api` 타입은 `"anthropic-messages"`로 설정한다.
- R3. `baseUrl`은 `$QUOTIO_BASE_URL` 환경변수에서 읽는다.
- R4. `apiKey`는 `$QUOTIO_API_KEY` 환경변수에서 읽는다.
- R5. `models` 배열에 최소 1개 이상의 모델을 정적으로 선언한다.
- R6. `session_start` 이벤트에서 `QUOTIO_BASE_URL`과 `QUOTIO_API_KEY` 환경변수 존재를 확인한다.
- R7. 환경변수가 누락된 경우 `ctx.ui.notify()`로 어떤 변수가 빠졌는지 명확히 알려주고, 프로바이더 등록을 스킵한다.
- R8. `/quotio-status` 슬래시 커맨드를 등록한다.
- R9. 커맨드 실행 시 quotio 프록시에 lightweight probe 요청을 보내 연결 상태를 확인한다.
- R10. 결과로 연결 성공/실패, 응답 시간, 에러 원인을 구분하여 보여준다.

---

## Scope Boundaries

- OpenAI 경로 지원은 이번 범위에 포함하지 않음
- 동적 모델 디스커버리 (`/v1/models` fetch)는 이번에 포함하지 않음
- 토큰 자동 갱신, OAuth, 폴백 로직은 포함하지 않음
- 빌드 파이프라인/테스트 설정은 이번에 포함하지 않음

---

## Context & Research

### Relevant Code and Patterns

- `extensions/workspace-connectors/index.ts` — `export default function(pi: ExtensionAPI)` 진입점 패턴
- `pi.registerCommand(name, { description, handler })` — 슬래시 커맨드 등록
- `pi.on("session_start", async (_event, ctx) => { ... })` — 세션 시작 훅
- `ctx.ui.notify(message, "info" | "error")` — 사용자 피드백
- `pi.registerTool({ name, parameters: Type.Object(...), execute })` — 도구 등록 (참고용)
- root `package.json`의 `"pi": { "extensions": ["./extensions"] }` — 자동 디스커버리

### Institutional Learnings

- 관련 기존 학습 문서 없음 (greenfield)

---

## Key Technical Decisions

- **Health check 방식**: `fetch(baseUrl)` HEAD/GET 요청으로 connectivity + 인증 상태를 확인. Anthropic API는 `/v1/models` 엔드포인트가 없으므로, base URL에 간단한 요청을 보내 HTTP 상태 코드로 판별 (200-299: 성공, 401: 인증 실패, 기타: 연결/URL 문제)
- **환경변수 검증 시점**: `session_start`에서 검증하되, 검증 실패 시에도 extension 자체는 로드됨 (provider만 미등록). 이로써 `/quotio-status`는 여전히 사용 가능
- **정적 모델 목록**: claude-sonnet-4-20250514 을 기본 모델로 선언. 사용자가 실제 사용 가능한 모델에 맞게 수정 가능

---

## Open Questions

### Resolved During Planning

- **Health check probe 형태**: base URL에 lightweight fetch 요청으로 HTTP 상태 코드 확인. 실제 completion 요청은 비용 발생하므로 사용하지 않음
- **URL 패턴**: 사용자가 `QUOTIO_BASE_URL`에 전체 경로를 포함하여 설정 (예: `https://proxy.example.com/anthropic/v1`). Extension은 URL을 조작하지 않고 그대로 전달

### Deferred to Implementation

- 정확한 모델 ID 및 메타데이터(context window, max tokens): quotio 관리자에게 확인 후 코드에 반영
- `registerProvider`의 `$ENV_VAR` 보간이 실제로 어떻게 동작하는지 (빈 문자열 vs undefined): 구현 시 테스트

---

## Output Structure

```
extensions/quotio-provider/
├── index.ts          ← 메인 확장 진입점
└── package.json      ← 확장 패키지 메타데이터
```

---

## Implementation Units

### U1. Extension 디렉터리 및 package.json 생성

**Goal:** `extensions/quotio-provider/` 디렉터리 구조를 만들고 패키지 메타데이터를 선언한다.

**Requirements:** R1 (구조적 전제조건)

**Dependencies:** None

**Files:**
- Create: `extensions/quotio-provider/package.json`

**Approach:**
- `workspace-connectors/package.json` 구조를 차용
- `"type": "module"`, 동일 의존성 (`@modelcontextprotocol/sdk` 제외 — 이 확장에선 불필요)
- devDependencies: `@earendil-works/pi-coding-agent`, `@types/node`, `typescript`
- 런타임 의존성: `typebox` (파라미터 스키마용)

**Patterns to follow:**
- `extensions/workspace-connectors/package.json`

**Test expectation:** none — 순수 scaffolding, 동작 변경 없음

**Verification:**
- `extensions/quotio-provider/package.json`이 유효한 JSON으로 존재

---

### U2. Provider 등록 + 환경변수 검증 구현

**Goal:** `index.ts`에서 환경변수를 검증하고, 유효한 경우 quotio 프로바이더를 등록한다.

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** U1

**Files:**
- Create: `extensions/quotio-provider/index.ts`

**Approach:**
- `export default function(pi: ExtensionAPI)` 진입점
- `pi.on("session_start")` 핸들러에서:
  1. `process.env.QUOTIO_BASE_URL`, `process.env.QUOTIO_API_KEY` 존재 확인
  2. 누락 시 `ctx.ui.notify("QUOTIO_BASE_URL 환경변수를 설정하세요", "error")` → return
  3. 유효 시 `pi.registerProvider("quotio", { ... })` 호출
- Provider config:
  - `name: "Quotio (Anthropic)"`
  - `baseUrl: "$QUOTIO_BASE_URL"`
  - `apiKey: "$QUOTIO_API_KEY"`
  - `api: "anthropic-messages"`
  - `models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", ... }]`
- models 배열에 기본 메타데이터 포함 (contextWindow, maxTokens)

**Patterns to follow:**
- `extensions/workspace-connectors/index.ts:78-84` — session_start + notify 패턴
- `extensions/workspace-connectors/index.ts:131-158` — registerTool 구조 (registerProvider는 유사한 패턴)

**Test scenarios:**
- Happy path: 두 환경변수 모두 설정됨 → provider 등록 성공, 세션 시작 시 정상 알림
- Error path: QUOTIO_BASE_URL 누락 → 에러 메시지에 "QUOTIO_BASE_URL" 언급, provider 미등록
- Error path: QUOTIO_API_KEY 누락 → 에러 메시지에 "QUOTIO_API_KEY" 언급, provider 미등록
- Error path: 둘 다 누락 → 두 변수 모두 언급하는 에러 메시지
- Edge case: 환경변수가 빈 문자열 → 누락으로 처리

**Verification:**
- 환경변수 설정 후 Pi 세션 시작 시 quotio provider가 모델 선택에 나타남
- 환경변수 미설정 시 명확한 에러 메시지가 표시되고 Pi가 정상 동작 (crash 없음)

---

### U3. /quotio-status Health Check 커맨드

**Goal:** `/quotio-status` 커맨드로 quotio 프록시 연결 상태를 진단할 수 있게 한다.

**Requirements:** R8, R9, R10

**Dependencies:** U2 (동일 파일에 추가)

**Files:**
- Modify: `extensions/quotio-provider/index.ts`

**Approach:**
- `pi.registerCommand("quotio-status", { description, handler })` 등록
- handler 내부:
  1. 환경변수 존재 확인 → 없으면 "환경변수 미설정" 메시지
  2. `fetch(baseUrl, { method: "GET", headers: { "Authorization": "Bearer " + apiKey } })` 수행
  3. 응답 시간 측정 (`Date.now()` 전후 차이)
  4. HTTP 상태 코드별 분류:
     - 2xx/4xx (서버 응답 있음): "연결 성공" + 응답 시간 + 상태 코드
     - 401/403: "인증 실패 — API key 확인 필요"
     - Network error (fetch throws): "연결 실패 — URL 확인 필요" + 에러 메시지
  5. `ctx.ui.notify()`로 결과 표시

**Patterns to follow:**
- `extensions/workspace-connectors/index.ts:112-129` — /connector-tools 커맨드 패턴 (service에 요청 후 결과 표시)

**Test scenarios:**
- Happy path: proxy 접근 가능 + 유효한 key → "연결 성공, 응답 시간: Xms"
- Error path: 유효하지 않은 API key → "인증 실패" 메시지
- Error path: URL 접근 불가 (네트워크 오류) → "연결 실패" + 구체적 원인
- Error path: 환경변수 미설정 상태에서 커맨드 실행 → "QUOTIO_BASE_URL / QUOTIO_API_KEY를 설정하세요"
- Edge case: 프록시가 느린 응답 (>5초) → timeout 처리 및 "응답 지연" 메시지

**Verification:**
- VPN 연결 + 환경변수 설정 상태에서 `/quotio-status` 실행 → 연결 성공 + 응답 시간 표시
- 잘못된 URL로 실행 → 명확한 에러 분류 메시지

---

## System-Wide Impact

- **Interaction graph:** Pi의 extension auto-discovery (`"pi": { "extensions": ["./extensions"] }`)가 새 디렉터리를 자동 감지. 기존 workspace-connectors에 영향 없음
- **Error propagation:** provider 등록 실패는 해당 provider만 비활성화. Pi 전체 동작에 영향 없음
- **State lifecycle risks:** 없음 — stateless 등록
- **API surface parity:** 향후 OpenAI 경로 추가 시 별도 provider 또는 동일 확장 내 추가 등록으로 확장
- **Unchanged invariants:** workspace-connectors 확장, 기존 Pi provider, MCP 도구 동작 불변

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| quotio proxy가 예상과 다른 인증 방식 사용 | headers config에 커스텀 헤더 추가 가능. 초기엔 Bearer token 가정 |
| Pi의 `$ENV_VAR` 보간이 예상과 다르게 동작 | session_start에서 직접 process.env 확인 후 조건부 등록으로 우회 |
| 정적 모델 ID가 quotio에서 인식 불가 | 사용자가 models 배열을 실제 ID로 교체. README에 설정 방법 안내 |

---

## Documentation / Operational Notes

- oh-my-pi `README.md`에 quotio provider 설정 방법 추가 필요 (환경변수 2개 + 사용법)
- `settings.example.json`은 변경 불필요 (패키지 설치 방식은 동일)

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-12-quotio-provider-requirements.md](docs/brainstorms/2026-06-12-quotio-provider-requirements.md)
- Related code: `extensions/workspace-connectors/index.ts` (패턴 참조)
- Related code: root `package.json` (pi.extensions 설정)
