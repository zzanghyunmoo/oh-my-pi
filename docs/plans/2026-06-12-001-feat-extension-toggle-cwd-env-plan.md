---
date: 2026-06-12
type: feat
title: "feat: 익스텐션 환경변수 토글 및 CWD .env 지원"
origin: docs/brainstorms/2026-06-12-extension-toggle-env-requirements.md
status: active
---

# feat: 익스텐션 환경변수 토글 및 CWD .env 지원

## Summary

oh-my-pi 패키지에 CWD `.env` 로딩 전용 익스텐션을 추가하고, 기존 두 익스텐션에 환경변수 기반 opt-in 토글을 적용한다. Pi 패키지 시스템의 익스텐션 로딩 순서를 활용하여 `.env` 파싱이 다른 익스텐션보다 먼저 완료되도록 보장한다.

---

## Problem Frame

(see origin: docs/brainstorms/2026-06-12-extension-toggle-env-requirements.md)

현재 oh-my-pi는 모든 익스텐션을 무조건 로드하며, 환경변수는 패키지 루트 `.env` 또는 `.zshrc`에서만 읽힌다. 프로젝트별로 익스텐션 구성을 달리하거나 환경변수를 격리할 수 없다.

---

## Key Technical Decisions

- **별도 env-loader 익스텐션 도입**: Pi는 `package.json`의 `"extensions"` 배열 순서대로 익스텐션을 로드하고, async factory를 await한 후 다음으로 넘어감. `env-loader`를 첫 번째로 배치하면 다른 익스텐션의 factory 호출 전에 CWD `.env`가 `process.env`에 반영됨.
- **토글 체크는 각 익스텐션 factory 진입부에서 수행**: `export default function` 최상단에서 `process.env.ENABLE_*`를 확인하고, `true`가 아니면 early-return. 모듈 자체는 로드되지만 등록은 발생하지 않음.
- **패키지 루트 `.env` 로딩 제거**: `quotio-provider`의 기존 `loadEnvFile()` top-level 호출을 삭제. env-loader가 이를 대체.
- **Override 의미론**: CWD `.env`의 값은 기존 `process.env`를 덮어씀 (표준 dotenv와 반대 — override 모드).

---

## Scope Boundaries

**포함:**
- CWD `.env` 로딩 익스텐션 신규 생성
- 기존 2개 익스텐션에 토글 가드 추가
- `quotio-provider`의 기존 `loadEnvFile()` 제거
- `package.json` extensions 배열 변경
- README 업데이트

**제외 (see origin):**
- 다중 `.env` 우선순위 체계
- 별도 config/settings.json 기반 토글
- 와일드카드 패턴 (`ENABLE_ALL=true`)
- 새 익스텐션 추가

### Deferred to Follow-Up Work

- 토글 변수 네이밍에 프리픽스 추가 (`OH_MY_PI_ENABLE_*`) — 현재는 `ENABLE_QUOTIO`, `ENABLE_WORKSPACE_CONNECTORS` 사용

---

## Implementation Units

### U1. env-loader 익스텐션 생성

**Goal:** CWD `.env`를 파싱하여 `process.env`에 override 방식으로 반영하는 전용 익스텐션 생성.

**Requirements:** R4, R5, R6, R8

**Dependencies:** 없음

**Files:**
- `extensions/env-loader/index.ts` (생성)
- `extensions/env-loader/package.json` (생성)

**Approach:**
- `export default function(pi)` factory에서 `process.cwd()` 기준 `.env` 파일 존재 여부 확인
- 존재하면 파싱하여 `process.env`에 덮어쓰기 (기존 값 override)
- 존재하지 않으면 무시 (에러 없이 진행)
- `session_start` 이벤트에서 로드된 `.env` 경로를 `ctx.ui.notify`로 알림
- 파서는 기존 `quotio-provider`의 `loadEnvFile()` 로직을 재활용하되, override 방식으로 변경

**Patterns to follow:**
- 기존 `quotio-provider/index.ts`의 `.env` 파싱 로직 (줄 단위, `#` 주석, 따옴표 스트립)
- Pi 익스텐션 factory 패턴 (`export default function(pi: ExtensionAPI)`)

**Test scenarios:**
- CWD에 `.env`가 있을 때 해당 값이 `process.env`에 반영됨
- CWD에 `.env`가 없을 때 에러 없이 정상 진행
- `.env`의 값이 기존 `process.env` 값을 덮어씀 (override 동작)
- `#` 주석과 빈 줄이 무시됨
- 따옴표로 감싼 값이 언래핑됨

**Verification:** `extensions/env-loader/index.ts`가 존재하고 `lsp_diagnostics` 클린.

---

### U2. package.json extensions 배열 재구성

**Goal:** `env-loader`가 가장 먼저 로드되도록 `package.json`의 extensions 선언 변경.

**Requirements:** R4 (로딩 순서 보장)

**Dependencies:** U1

**Files:**
- `package.json` (수정)

**Approach:**
- 기존 `"extensions": ["./extensions"]`를 개별 익스텐션 경로 배열로 변경
- 순서: `["./extensions/env-loader", "./extensions/quotio-provider", "./extensions/workspace-connectors"]`
- 이렇게 하면 Pi가 env-loader를 먼저 로드 → await → 나머지 로드

**Patterns to follow:**
- Pi 문서의 패키지 `pi.extensions` 배열 규약

**Test scenarios:**
- Covers AE1. Pi가 env-loader를 첫 번째로 로드하여 토글 변수가 다른 익스텐션 로드 전에 사용 가능

**Verification:** `package.json` 구조가 올바른 JSON이고, Pi가 세 익스텐션을 순서대로 로드.

---

### U3. quotio-provider에 토글 가드 추가 및 loadEnvFile 제거

**Goal:** `quotio-provider`에 opt-in 토글을 적용하고, 기존 패키지 루트 `.env` 로딩 로직을 제거.

**Requirements:** R1, R2, R3, R7

**Dependencies:** U1, U2

**Files:**
- `extensions/quotio-provider/index.ts` (수정)

**Approach:**
- `loadEnvFile()` 함수와 top-level 호출 삭제 (더 이상 패키지 루트 `.env`를 읽지 않음)
- `export default function` 최상단에 토글 체크 추가:
  ```
  if (process.env.ENABLE_QUOTIO !== "true") return;
  ```
- 나머지 로직은 그대로 유지 (프로바이더 등록, 커맨드 등록 등)

**Patterns to follow:**
- Pi 익스텐션의 early-return 패턴

**Test scenarios:**
- Covers AE1. `ENABLE_QUOTIO=true`일 때 프로바이더가 정상 등록됨
- `ENABLE_QUOTIO`가 없거나 `false`일 때 프로바이더 미등록, 에러 없음
- Covers AE3. CWD `.env`에서 `QUOTIO_BASE_URL`을 오버라이드하면 새 값이 사용됨

**Verification:** `lsp_diagnostics` 클린. 기존 `loadEnvFile` 참조가 없음.

---

### U4. workspace-connectors에 토글 가드 추가

**Goal:** `workspace-connectors`에 opt-in 토글을 적용.

**Requirements:** R1, R2, R3

**Dependencies:** U2

**Files:**
- `extensions/workspace-connectors/index.ts` (수정)

**Approach:**
- `export default function` 최상단에 토글 체크 추가:
  ```
  if (process.env.ENABLE_WORKSPACE_CONNECTORS !== "true") return;
  ```
- 나머지 로직 그대로 유지

**Patterns to follow:**
- U3과 동일한 토글 패턴

**Test scenarios:**
- `ENABLE_WORKSPACE_CONNECTORS=true`일 때 도구/커맨드가 정상 등록됨
- 토글이 없거나 `false`일 때 도구/커맨드 미등록, 에러 없음

**Verification:** `lsp_diagnostics` 클린.

---

### U5. 세션 시작 알림 — 비활성화된 익스텐션 목록 표시

**Goal:** 토글 미설정으로 비활성화된 익스텐션 목록을 사용자에게 알림.

**Requirements:** R2 (마이그레이션 알림)

**Dependencies:** U1, U3, U4

**Files:**
- `extensions/env-loader/index.ts` (수정)

**Approach:**
- env-loader의 `session_start` 핸들러에서 알려진 익스텐션 목록(`ENABLE_QUOTIO`, `ENABLE_WORKSPACE_CONNECTORS`)을 확인
- `true`가 아닌 것들의 이름을 모아서 `ctx.ui.notify`로 표시
- 예: `"비활성화된 익스텐션: quotio-provider, workspace-connectors. .env에 ENABLE_*=true를 추가하세요."`
- 모든 익스텐션이 활성화되어 있으면 이 알림 생략

**Patterns to follow:**
- 기존 `quotio-provider`의 `session_start` 알림 패턴

**Test scenarios:**
- 토글 변수가 하나도 없을 때 비활성화 목록 전체를 알림으로 표시
- 모든 토글이 `true`일 때 알림 없음
- 일부만 활성화 시 비활성화된 것만 표시

**Verification:** 알림 메시지가 의도대로 구성됨. `lsp_diagnostics` 클린.

---

### U6. README 및 AGENTS.md 업데이트

**Goal:** 새로운 사용법을 문서에 반영.

**Requirements:** 전체

**Dependencies:** U1-U5

**Files:**
- `README.md` (수정)
- `AGENTS.md` (수정)

**Approach:**
- README: "Setup" 섹션에 CWD `.env` 사용법 및 토글 변수 설명 추가
- README: 기존 "패키지 루트 `.env`" 언급을 CWD `.env`로 변경
- AGENTS.md: 프로젝트 구조에 `env-loader` 추가, Extension 개발 규칙에 토글 패턴 추가

**Test expectation:** none — 문서 변경만.

**Verification:** 문서 내용이 구현과 일치.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| Pi가 extensions 배열의 개별 경로를 디렉토리처럼 처리하지 않을 수 있음 | Pi 문서에서 `"pi": { "extensions": ["./src/index.ts"] }` 패턴 확인 완료 — 디렉토리 경로도 지원 |
| extensions 배열 순서가 로딩 순서를 보장하지 않을 수 있음 | Pi 문서: "If the factory returns a Promise, pi awaits it before continuing startup" — 순서 보장됨 |
| 기존 사용자가 전환 후 익스텐션 미로드로 혼란 | U5에서 세션 시작 알림으로 마이그레이션 가이드 제공 |

---

## System-Wide Impact

- **기존 패키지 루트 `.env`를 사용하던 환경**: 패키지 루트 `.env`가 더 이상 읽히지 않으므로, 사용자는 CWD `.env`로 이동하거나 `.zshrc`에서 export해야 함.
- **Pi 패키지 설치 방식**: `pi install git:...`으로 설치 시 `package.json`의 새 extensions 배열이 그대로 적용됨. 추가 설정 불필요.
