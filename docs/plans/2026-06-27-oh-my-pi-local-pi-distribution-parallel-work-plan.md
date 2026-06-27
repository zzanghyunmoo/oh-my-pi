---
date: 2026-06-27
topic: oh-my-pi-local-pi-distribution
source: docs/ideation/2026-06-27-oh-my-pi-local-pi-distribution-ideation.html
artifact_type: parallel-work-plan
status: draft
---

# oh-my-pi local Pi distribution — 병렬 작업 순서

## 목적

`docs/ideation/2026-06-27-oh-my-pi-local-pi-distribution-ideation.html`의 7개 아이디어를 바로 구현 목록으로 흩트리지 않고, 향후 `/ce-brainstorm`, `/ce-plan`, `/ce-work`에 넘길 수 있는 실행 순서로 정리한다.

이 문서는 **ideation 원본을 수정하지 않는 companion plan**이다. Ideation 문서는 후보와 근거를 보존하고, 이 문서는 이후 작업 배치/의존성/병렬 처리 한도를 갱신하는 살아있는 작업 지도 역할을 한다.

## 병렬 처리 원칙

- **브레인스토밍/요구사항화:** 최대 7개 아이디어를 동시에 검토할 수 있지만, 품질과 합성을 위해 한 번에 2~3개 배치를 기본값으로 둔다.
- **계획/스펙화:** 서로 의존성이 약한 주제는 3~5개까지 병렬 가능하다.
- **실제 코드 수정:** 같은 worktree에서는 writer를 1명만 둔다. read-only 조사/리뷰는 병렬 가능하지만, 구현자는 한 번에 하나의 통합 diff만 만든다.
- **동시 활성 feature track:** 충돌을 줄이기 위해 2~3개를 넘기지 않는다.
- **공통 결정은 선행:** toggle/env/registry/secret처럼 여러 아이디어가 공유하는 계약은 먼저 고정한다.

## 의존성 지도

```text
Foundation
  Idea 3. Capability Registry + Extension Capsules
  Idea 6. Secret Blueprint + Secret References
      ↓
Diagnostics MVP
  Idea 2. Setup Doctor + Command Palette
      ↓
Connector / Provider Layer
  Idea 4. Connector Backend Catalog + Adapter Router
  Idea 5. Provider Adapter Kit + Capability Contract
      ↓
Distribution / Reproducibility
  Idea 1. 실행 가능한 프로필 팩 + Lockfile
      ↓
Runtime Governance
  Idea 7. Runtime Safety Policy Ledger
```

핵심 판단:

- **Idea 3**은 loader, doctor, README, `.env.example`, profile compiler가 공유할 중심 schema라서 먼저 잡아야 한다.
- **Idea 6**은 어떤 값이 커밋 가능한 blueprint이고 어떤 값이 local secret인지 결정하므로, Doctor와 Profile Pack의 전제다.
- **Idea 2**는 사용자 체감이 가장 빠른 MVP지만, 중복 구현을 피하려면 Idea 3/6의 최소 계약을 읽는 형태로 만든다.
- **Idea 4/5**는 둘 다 backend/provider 추상화라서 병렬 요구사항화가 가능하다. 구현은 공통 capability contract에 맞춰 한 writer가 합치는 편이 안전하다.
- **Idea 1**은 최종 배포판 경험이지만, registry/catalog/secret/provider 결과를 소비하므로 구현은 후순위다.
- **Idea 7**은 안전 정책의 방향은 일찍 논의하되, 실제 runtime gate는 connector/tool wrapper 경계가 보인 뒤 구현한다.

## 추천 작업 배치

### Batch 0 — 현재 상태 인벤토리

**목표:** oh-my-pi가 지금 어떤 Pi package, extension, prompt/theme, 외부 설치 패키지를 포함해야 하는지 정리한다.

**포함 항목:**

- `package.json`의 `pi.extensions`, `prompts`, `themes`
- `extensions/env-loader`, `extensions/quotio-provider`, `extensions/workspace-connectors`
- `settings.example.json`
- 최근 수동 설치 신호: `pi install npm:pi-clear`

**산출물:** 구현 문서가 아니라 다음 Batch 1 문서들에 넣을 근거 목록.

### Batch 1 — MVP Foundation

**병렬로 요구사항화할 아이디어:**

1. **Idea 3. 자기 설명형 Capability Registry + Extension Capsules**
2. **Idea 6. 비밀값 없는 Blueprint + Secret References**
3. **Idea 2. Setup Doctor + Command Palette**

**왜 먼저:**

- 배포판이 되려면 “무엇이 설치/활성화/진단되는가”를 코드와 문서가 같은 소스에서 읽어야 한다.
- 사용자는 설치 직후 `/oh-my-pi-doctor` 같은 단일 진단 명령으로 현재 상태를 이해해야 한다.
- Secret boundary를 먼저 정해야 Profile Pack과 lockfile이 위험한 값을 포함하지 않는다.

**브레인스토밍 출력 후보:**

- `docs/brainstorms/2026-06-27-capability-registry-requirements.md`
- `docs/brainstorms/2026-06-27-secret-blueprint-requirements.md`
- `docs/brainstorms/2026-06-27-setup-doctor-requirements.md`

**구현 순서:**

1. Registry 최소 schema
2. Secret/blueprint boundary
3. Doctor가 registry + secret schema를 읽어 진단

### Batch 2 — Connector / Provider Layer

**병렬로 요구사항화할 아이디어:**

1. **Idea 4. Connector Backend Catalog + Adapter Router**
2. **Idea 5. Provider Adapter Kit + Capability Contract**

**왜 다음:**

- Linear/Notion/GitHub/Quotio처럼 backend 성격이 다른 integration을 같은 catalog 관점으로 정리한다.
- Quotio provider에서 이미 있는 discovery/status/capability 로직을 provider adapter contract로 일반화한다.

**브레인스토밍 출력 후보:**

- `docs/brainstorms/2026-06-27-connector-backend-catalog-requirements.md`
- `docs/brainstorms/2026-06-27-provider-adapter-kit-requirements.md`

**구현 순서:**

1. Provider adapter kit의 최소 contract
2. Connector catalog entry schema
3. Adapter router / fallback policy
4. Doctor에 backend/provider status 통합

### Batch 3 — Distribution / Reproducibility

**대상 아이디어:**

1. **Idea 1. 실행 가능한 프로필 팩 + Lockfile**

**왜 후순위:**

- Profile Pack은 registry, secret blueprint, connector catalog, provider adapter의 결과를 묶는 상위 레이어다.
- `pi install npm:pi-clear`처럼 수동 설치한 package도 profile/lock/receipt에 기록할지 이 단계에서 결정한다.

**브레인스토밍 출력 후보:**

- `docs/brainstorms/2026-06-27-profile-pack-lockfile-requirements.md`

**구현 순서:**

1. Profile schema 초안
2. Lock/receipt에 기록할 대상 정의
3. Apply/verify UX
4. README 설치 흐름 갱신

### Batch 4 — Runtime Governance

**대상 아이디어:**

1. **Idea 7. Runtime Safety Policy Ledger**

**왜 마지막:**

- 안전 정책은 중요하지만, 실제 gate를 어디에 걸지는 connector/tool/provider wrapper 경계가 정리된 뒤가 더 명확하다.
- Batch 1에서 safety class 필드만 선반영하고, runtime enforcement는 이 배치에서 다룬다.

**브레인스토밍 출력 후보:**

- `docs/brainstorms/2026-06-27-runtime-safety-policy-ledger-requirements.md`

## 향후 명령 예시

### Batch 1을 병렬로 요구사항화

```text
/ce-brainstorm projects/oh-my-pi/docs/plans/2026-06-27-oh-my-pi-local-pi-distribution-parallel-work-plan.md 의 Batch 1을 기준으로 Idea 3, Idea 6, Idea 2를 병렬로 요구사항 문서로 쪼개줘. 구현은 하지 말고, 각 결과는 docs/brainstorms/ 아래에 저장해. 마지막에 세 문서 사이의 공통 결정, 충돌, 의존성을 요약해줘.
```

### Batch 2를 병렬로 요구사항화

```text
/ce-brainstorm projects/oh-my-pi/docs/plans/2026-06-27-oh-my-pi-local-pi-distribution-parallel-work-plan.md 의 Batch 2를 기준으로 Connector Backend Catalog와 Provider Adapter Kit를 병렬로 요구사항화해줘. 구현은 하지 말고, 공통 capability contract가 충돌하지 않게 마지막에 통합 요약을 만들어줘.
```

### 구현 단계로 넘어갈 때

```text
/ce-plan docs/brainstorms/<선택한-requirements>.md 를 구현 가능한 plan으로 바꿔줘.
```

```text
/ce-work docs/plans/<선택한-plan>.md 를 실행해줘. 같은 worktree에서는 writer 한 명만 쓰고, read-only 리뷰는 병렬로 돌려도 돼.
```

## 업데이트 규칙

- 각 Batch의 `/ce-brainstorm` 결과가 생기면 이 문서의 “브레인스토밍 출력 후보”를 실제 파일 경로로 갱신한다.
- 구현 중 새 의존성이 발견되면 의존성 지도와 Batch 순서를 갱신한다.
- 구현이 끝난 durable learning은 `docs/solutions/`에 남긴다.
- Ideation HTML은 후보 탐색 기록으로 보존하고, 실행 순서 변경은 이 문서에 기록한다.
