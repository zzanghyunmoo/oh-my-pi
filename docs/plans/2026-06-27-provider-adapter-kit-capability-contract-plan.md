---
date: 2026-06-27
topic: provider-adapter-kit-capability-contract
artifact_type: implementation-plan
status: implemented
---

# Provider Adapter Kit + Capability Contract 구현 계획

## 목표

Quotio처럼 OpenAI-compatible 프록시를 Pi provider로 등록할 때 반복되는 URL 정규화, Bearer 인증 기반 `/models` 디스커버리, timeout/auth 진단, 모델 capability/cost 매핑을 재사용 가능한 adapter kit로 분리한다.

## 범위

- `extensions/provider-adapter-kit/`에 런타임 익스텐션이 아닌 공유 TypeScript 모듈을 추가한다.
- `extensions/quotio-provider/index.ts`는 기존 공개 동작을 유지하면서 kit를 소비하도록 리팩터링한다.
  - `ENABLE_QUOTIO=true` opt-in 유지
  - `/quotio-status` 유지
  - 동적 `/models` discovery 유지
  - provider 등록명 `quotio` 유지
- `workspace-connectors`, `setup-doctor`, `capability-registry`는 충돌을 줄이기 위해 수정하지 않는다.

## 구현 단계

1. OpenAI-compatible provider adapter kit 추가
   - base URL 정규화
   - Bearer auth `/models` discovery
   - timeout/auth/http/network 진단용 에러 분류
   - provider model capability contract와 기본/override 매핑
2. Quotio provider 리팩터링
   - env 검증과 Pi command/provider 등록 흐름은 유지
   - Quotio 모델 capability 규칙을 kit 설정으로 이동
3. 검증 및 자체 리뷰
   - `npm ci`
   - `npm exec tsc -- --module NodeNext --moduleResolution NodeNext --target ES2022 --noEmit --skipLibCheck --types node extensions/**/*.ts`
   - 변경 범위가 요청된 경계 안에 머무르는지 확인

## 후속으로 남길 항목

- setup doctor가 provider adapter kit의 진단 함수를 공유하도록 통합
- capability registry에 provider capability contract 요약을 노출
- Quotio 실제 과금표가 확정되면 cost override를 0 기본값에서 실제 값으로 갱신
