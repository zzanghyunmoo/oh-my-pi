---
title: "oh-my-pi 로컬 Pi 배포판은 작은 병렬 PR 묶음으로 키운다"
module: oh-my-pi
date: 2026-06-27
problem_type: workflow
component: local-pi-distribution
severity: medium
applies_when:
  - "oh-my-pi에 여러 익스텐션, provider, connector, profile 기능을 한 번에 추가할 때"
  - "아이디에이션 결과를 병렬 PR로 나누어 구현하고 마지막에 통합해야 할 때"
  - "로컬 설정/시크릿/프로필/안전 정책을 commit-safe하게 재현하려 할 때"
tags:
  - oh-my-pi
  - pi-package
  - parallel-pr
  - profile-pack
  - capability-registry
  - setup-doctor
  - safety-policy
---

<!-- markdownlint-disable MD013 MD025 -->

# oh-my-pi 로컬 Pi 배포판은 작은 병렬 PR 묶음으로 키운다

## Context

`oh-my-pi`를 개인용 익스텐션 모음에서 “내 로컬 Pi 배포판”으로 키우는 작업은 한 PR로 처리하기에는 범위가 컸다. capability registry, secret blueprint, setup doctor, connector catalog, provider adapter, profile pack, runtime safety ledger가 서로 연결되어 있었고, 동시에 같은 파일을 건드리면 충돌이 생길 수 있었다.

이번 작업은 ideation 문서를 기준으로 Batch를 나누고, 각 Batch 안에서는 독립 브랜치/PR로 병렬 처리했다. 마지막에는 통합 브랜치에서 전체 검증과 문서화를 수행했다.

## Guidance

### 1. 후보 탐색 문서와 실행 순서 문서를 분리한다

아이디어 후보와 근거는 `docs/ideation/`에 보존하고, 실제 병렬 처리 순서와 의존성은 별도 `docs/plans/*parallel-work-plan.md`에 둔다. Ideation 문서를 계속 수정하면 “왜 이 아이디어가 나왔는지”와 “지금 어떤 순서로 실행할지”가 섞인다.

### 2. 병렬 PR은 충돌 경계를 먼저 정한다

각 PR prompt에는 다음을 명시한다.

- 허용 파일: 이번 PR이 실제로 수정할 파일
- 금지 파일: 병렬 PR과 충돌할 가능성이 큰 파일
- 후속 처리: doctor/registry 통합처럼 여러 PR이 끝난 뒤 하는 작업
- PR base: 기능 PR들은 `main`이 아니라 통합 브랜치를 base로 둔다

이번 작업의 예시는 다음과 같다.

- Batch 1: capability registry, secret blueprint, setup doctor
- Batch 2: connector backend catalog, provider adapter kit
- Batch 3: profile pack + lockfile
- Batch 4: runtime safety policy ledger
- Final integration: setup doctor가 registry/catalog/provider/safety ledger를 함께 요약

### 3. 배포판 상태는 여러 commit-safe contract로 나눈다

한 파일에 모든 설정을 몰아넣지 않는다.

- `extensions/capability-registry.ts`: 어떤 capability가 존재하고 어떤 toggle/env/command/tool/provider를 노출하는지
- `docs/blueprints/`: 어떤 로컬 값과 secret reference가 필요한지
- `extensions/connector-backend-catalog.ts`: 각 connector가 MCP/CLI/provider 중 어떤 backend를 쓰는지
- `extensions/provider-adapter-kit/`: OpenAI-compatible provider discovery/diagnostics/capability mapping
- `docs/profiles/`: profile pack과 deterministic lock receipt
- `extensions/runtime-safety-policy-ledger.ts`: tool/provider/connector별 안전 정책
- `extensions/setup-doctor/`: 위 contract들을 읽어 사용자가 현재 상태를 이해하게 하는 진단 표면

### 4. 실제 시크릿과 OAuth 상태는 끝까지 로컬 전용으로 둔다

Profile과 lockfile에는 “무엇이 필요하다”는 intent만 기록하고, 값은 `.env`, `.mcp-auth`, keychain, `~/.pi/agent/auth.json` 같은 local-only 위치에 둔다. `profile:apply`도 실제 설치나 `.env` 쓰기를 하지 않는 dry-run checklist로 유지한다.

### 5. 마지막에 통합 검증 PR을 만든다

병렬 PR이 모두 통합 브랜치에 머지되면, 바로 `main`으로 올리지 말고 한 번 더 통합 검증을 수행한다.

- `npm ci`
- `npm run profile:verify`
- focused TypeScript check
- `git diff --check`
- 가능하면 `/oh-my-pi-doctor`, `/oh-my-pi`, `/quotio-status`, connector OAuth flow 수동 확인

## Why This Matters

- **충돌 감소:** 각 PR의 수정 경계가 작아져 병렬 처리 중 충돌이 줄어든다.
- **리뷰 가능성:** 리뷰어가 capability/secret/doctor/provider/profile/safety를 독립 주제로 읽을 수 있다.
- **재현성:** 새 머신에서 필요한 package, toggle, secret reference, connector/provider intent를 lock/receipt로 확인할 수 있다.
- **안전성:** 강력한 workspace connector와 provider가 늘어나도 runtime policy ledger와 doctor가 현재 안전 경계를 설명한다.

## When to Apply

- Pi package를 “개인 배포판”처럼 키울 때
- 여러 extension/provider/connector가 같은 설정·진단·보안 경계를 공유할 때
- 작업량이 크지만 PR별 책임 경계를 명확히 나눌 수 있을 때
- 시크릿 값을 커밋하지 않으면서 로컬 setup intent를 재현해야 할 때

## Examples

### 병렬 PR prompt의 핵심 문장

```text
Base PR target MUST be feat/local-pi-distribution, not main.
Keep conflict-light: do NOT edit extensions/quotio-provider/index.ts in this PR.
If doctor/registry integration is desirable, document it as a follow-up.
PR title/body MUST be Korean and use the 4-section PR template.
```

### 최종 통합 doctor가 보여줘야 할 축

```text
Capability registry: env-loader, quotio-provider, workspace-connectors, setup-doctor
Extension toggles: ENABLE_QUOTIO, ENABLE_WORKSPACE_CONNECTORS
Connector backend catalog: linear=oauth-mcp, notion=oauth-mcp, github=cli, quotio=provider
Runtime safety ledger: workspace_mcp_call_tool=confirm-write, github_gh_cli=read-only/blocked-in-tool
Profile pack: npm run profile:verify, npm run profile:apply -- --profile full
```

## Related

- `docs/ideation/2026-06-27-oh-my-pi-local-pi-distribution-ideation.html`
- `docs/plans/2026-06-27-oh-my-pi-local-pi-distribution-parallel-work-plan.md`
- `docs/solutions/conventions/pi-extension-toggle-cwd-env-2026-06-12.md`
