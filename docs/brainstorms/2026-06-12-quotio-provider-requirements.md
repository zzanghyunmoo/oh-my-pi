---
date: 2026-06-12
topic: quotio-provider
---

# Quotio Proxy Provider Extension

## Summary

oh-my-pi에 `extensions/quotio-provider/` 확장을 추가한다. Anthropic Messages API 경로를 기본으로 quotio 프록시에 연결하는 커스텀 프로바이더를 등록하고, 세션 시작 시 환경변수 검증 + 연결 확인을 수행하며, `/quotio-status` 커맨드로 진단을 제공한다.

## Problem Frame

현재 oh-my-pi에는 커스텀 LLM 프로바이더가 없다. quotio 프록시를 통해 모델을 사용하려면 Pi 외부에서 별도 설정을 해야 하고, 연결이 안 될 때 원인 파악이 어렵다. 환경변수 누락, URL 오타, 프록시 다운 등의 문제가 런타임에야 불투명한 에러로 나타난다.

## Requirements

**프로바이더 등록**
- R1. `extensions/quotio-provider/index.ts`에서 `pi.registerProvider("quotio", config)`를 호출하여 프로바이더를 등록한다.
- R2. `api` 타입은 `"anthropic-messages"`로 설정한다.
- R3. `baseUrl`은 `$QUOTIO_BASE_URL` 환경변수에서 읽는다 (quotio의 Anthropic 경로 포함, e.g., `https://proxy.example.com/anthropic`).
- R4. `apiKey`는 `$QUOTIO_API_KEY` 환경변수에서 읽는다.
- R5. `models` 배열에 최소 1개 이상의 모델을 정적으로 선언한다 (초기 구현).

**환경변수 검증**
- R6. `session_start` 이벤트에서 `QUOTIO_BASE_URL`과 `QUOTIO_API_KEY` 환경변수 존재를 확인한다.
- R7. 환경변수가 누락된 경우 `ctx.ui.notify()`로 어떤 변수가 빠졌는지 명확히 알려주고, 프로바이더 등록을 스킵한다.

**Health Check 커맨드**
- R8. `/quotio-status` 슬래시 커맨드를 등록한다.
- R9. 커맨드 실행 시 quotio 프록시에 lightweight probe 요청을 보내 연결 상태를 확인한다.
- R10. 결과로 연결 성공/실패, 응답 시간, 에러 원인(URL 오류, 인증 실패, 네트워크 문제)을 구분하여 보여준다.

## Success Criteria

- 환경변수 2개만 설정하면 Pi에서 quotio를 통해 Anthropic 모델을 사용할 수 있다.
- 환경변수 누락이나 프록시 연결 실패 시, 사용자가 원인을 즉시 파악할 수 있다.

## Scope Boundaries

- OpenAI 경로 지원은 이번 범위에 포함하지 않음 (추후 두 번째 프로바이더로 추가 가능)
- 동적 모델 디스커버리 (`/v1/models` fetch)는 이번에 포함하지 않음
- 토큰 자동 갱신, OAuth, 폴백 로직은 포함하지 않음
- 빌드 파이프라인/테스트 설정은 이번에 포함하지 않음

## Key Decisions

- Anthropic 경로 먼저: quotio가 경로별 분리 구조이므로 `baseUrl`에 Anthropic 경로를 포함하여 단일 프로바이더로 등록
- Extension 구조: `extensions/quotio-provider/` 디렉터리로 분리하여 workspace-connectors 패턴 유지
- 정적 모델 목록: 초기엔 하드코딩, 동적 디스커버리는 이후 iteration

## Dependencies / Assumptions

- quotio 프록시가 Anthropic Messages API 호환 엔드포인트를 `/anthropic/...` 같은 경로에 제공한다고 가정
- Pi의 `registerProvider`가 `api: "anthropic-messages"` + `baseUrl` 조합으로 정상 동작한다고 가정
- quotio 인증은 단순 API key (Bearer token) 방식이라고 가정

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Needs research] quotio의 Anthropic 경로 정확한 URL 패턴 확인 필요 (e.g., `/anthropic/v1/messages` vs `/anthropic`)
- [Affects R5][Needs research] quotio를 통해 사용 가능한 Anthropic 모델 목록과 메타데이터(context window, max tokens) 확인 필요
- [Affects R9][Technical] health check probe로 적합한 lightweight 요청 형태 결정 (GET /models vs minimal completion 등)
