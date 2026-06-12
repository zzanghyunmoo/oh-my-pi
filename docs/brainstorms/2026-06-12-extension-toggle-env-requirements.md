---
date: 2026-06-12
topic: extension-toggle-and-cwd-env
---

# 익스텐션 토글 및 CWD .env 지원

## Summary

oh-my-pi 패키지의 익스텐션을 환경변수 기반으로 선택적 활성화(opt-in)하고, 환경변수 소스를 패키지 루트 `.env`에서 에이전트 실행 디렉토리(CWD)의 `.env`로 전환한다. 토글 변수와 실제 API key 등을 하나의 CWD `.env`에서 통합 관리.

---

## Problem Frame

현재 oh-my-pi는 `extensions/` 디렉토리의 모든 익스텐션을 무조건 로드한다. 특정 환경에서 불필요한 익스텐션이 세션 시작 시 에러를 뿜거나 리소스를 잡아먹어도 끌 방법이 없다. 또한 환경변수를 `.zshrc`에 직접 export하거나 패키지 루트 `.env`에 넣어야 하는데, 에이전트가 실제로 실행되는 디렉토리와 패키지 루트가 다르면 관리가 번거롭다.

---

## Requirements

**환경변수 기반 익스텐션 토글**

- R1. 각 익스텐션은 대응하는 환경변수가 `true`일 때만 활성화된다 (예: `ENABLE_QUOTIO=true`, `ENABLE_WORKSPACE_CONNECTORS=true`).
- R2. 토글 환경변수가 없거나 `true` 이외의 값이면 해당 익스텐션은 로드하지 않는다 (opt-in, 기본 비활성화). 기존 환경에서 전환 시 세션 시작 알림으로 토글 미설정 익스텐션 목록을 표시하여 사용자가 인지할 수 있도록 한다.
- R3. 비활성화된 익스텐션은 세션 시작 시 도구, 커맨드, 프로바이더를 등록하지 않으며 리소스 소비 동작을 수행하지 않는다. (모듈 자체는 Pi 패키지 시스템에 의해 로드될 수 있으나, export default function 내부에서 early-return하여 등록을 방지한다.)

**CWD .env 로딩**

- R4. CWD `.env` 파싱은 모든 익스텐션의 `export default function` 호출 이전에 완료되어야 한다. 에이전트 실행 디렉토리(CWD)에 `.env` 파일이 있으면 파싱하여 `process.env`에 반영한다.
- R5. CWD `.env`의 값은 이미 세팅된 `process.env` 값을 덮어쓴다 (CWD .env가 우선). 세션 시작 시 로드된 `.env` 경로를 알림으로 표시하여 어떤 값이 적용됐는지 추적 가능하도록 한다.
- R6. CWD에 `.env`가 없으면 기존 `process.env`만으로 동작한다 (에러 없이 정상 진행).
- R7. 기존 패키지 루트 `.env` 로딩 로직(`quotio-provider`의 `loadEnvFile()`)은 제거한다.

**통합 관리**

- R8. 토글 변수(`ENABLE_*`)와 익스텐션이 사용하는 실제 환경변수(`QUOTIO_API_KEY` 등)를 하나의 CWD `.env`에서 관리할 수 있다.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** CWD `.env`에 `ENABLE_QUOTIO=true`와 `QUOTIO_API_KEY=xxx`가 있을 때, quotio-provider가 활성화되고 프로바이더가 등록된다. `ENABLE_WORKSPACE_CONNECTORS`가 없으면 workspace-connectors는 로드되지 않는다.
- AE2. **Covers R4, R6.** CWD에 `.env` 파일이 없고, `.zshrc`에서 `export ENABLE_QUOTIO=true`와 `export QUOTIO_API_KEY=xxx`가 세팅되어 있으면 quotio-provider가 정상 활성화된다.
- AE3. **Covers R5, R7.** `.zshrc`에 `QUOTIO_BASE_URL=http://old:8000/v1`이 있고, CWD `.env`에 `QUOTIO_BASE_URL=http://new:8317/v1`이 있으면, 새 값(`http://new:8317/v1`)이 사용된다.

---

## Success Criteria

- 에이전트가 어떤 프로젝트 디렉토리에서 실행되든, 해당 디렉토리의 `.env` 하나로 oh-my-pi 익스텐션 구성을 완전히 제어할 수 있다.
- 불필요한 익스텐션이 로드되지 않아 세션 시작 시 불필요한 에러/알림이 사라진다.

---

## Scope Boundaries

- 다중 `.env` 우선순위 체계 (패키지 루트 폴백 없음)
- 별도 config 파일이나 `settings.json` 기반 토글
- 와일드카드 패턴 (`ENABLE_ALL=true` 등)
- 새로운 익스텐션 추가 (기존 2개에 대해서만 적용)

---

## Key Decisions

- **Opt-in 방식 선택**: 새 익스텐션이 추가되어도 기존 환경에 자동으로 영향을 주지 않도록 명시적 활성화 필요.
- **패키지 루트 `.env` 제거**: CWD `.env`와 패키지 루트 `.env`가 공존하면 혼란을 줄 수 있으므로 단일 소스로 단순화.
- **CWD .env가 process.env를 오버라이드**: `.zshrc` 기본값을 프로젝트별로 덮어쓸 수 있어야 유연.

---

## Dependencies / Assumptions

- Pi 패키지 시스템이 익스텐션 진입점(`export default function`)의 조건부 등록을 허용한다고 가정.
- `.env` 파싱은 기존 `quotio-provider`에 있는 간단한 파서 수준이면 충분 (dotenv 라이브러리 불필요 가정).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] 토글 환경변수 네이밍 규칙 — `ENABLE_QUOTIO` vs `ENABLE_QUOTIO_PROVIDER` vs `OH_MY_PI_ENABLE_QUOTIO` 등 정확한 변수명은 구현 시 확정.
- [Affects R4][Technical] `.env` 파싱 로직을 각 익스텐션에 두는 대신 공통 유틸로 뽑을지는 구현 구조 결정 시 확정.
