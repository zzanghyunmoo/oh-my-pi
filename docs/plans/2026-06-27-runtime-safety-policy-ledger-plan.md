---
date: 2026-06-27
topic: runtime-safety-policy-ledger
source: docs/plans/2026-06-27-oh-my-pi-local-pi-distribution-parallel-work-plan.md#batch-4--runtime-governance
artifact_type: implementation-plan
status: implemented
---

# Runtime Safety Policy Ledger 구현 계획

## 목표

oh-my-pi의 connector/provider/tool 런타임 안전 기대치를 typed ledger로 모으고, 이미 존재하는 workspace-connectors의 안전 가드와 프롬프트 안내가 같은 정책 소스를 읽도록 정리한다.

## 범위

- connector/provider/tool 정책을 선언하는 typed runtime safety policy ledger를 추가한다.
- 정책에는 read-only, confirm-write, blocklist/allowlist hint, safety class, redaction/audit guidance, 승인/확인 기대치를 포함한다.
- `github_gh_cli`의 known mutating gh subcommand 차단 목록을 connector catalog가 아니라 ledger에서 읽게 한다.
- `workspace_mcp_list_tools`, `workspace_mcp_call_tool`, `github_gh_cli`의 prompt guidance/details에 ledger 기반 classification을 추가한다.
- 공개 명령/도구 이름과 기존 read-only/list/call 동작은 유지한다.
- 새 Pi extension, `package.json`, profile-pack 파일은 추가/수정하지 않는다.

## 구현 단계

1. `extensions/runtime-safety-policy-ledger.ts`에 정책 타입, ledger entry, 조회/요약 helper, gh CLI blocklist helper를 추가한다.
2. `extensions/connector-backend-catalog.ts`에서 GitHub mutating subcommand 목록을 제거해 ledger가 runtime guard의 단일 소스가 되게 한다.
3. `extensions/workspace-connectors/index.ts`에서 ledger helper를 import해 prompt guidance/details 및 GitHub mutation guard에 연결한다.
4. `npm ci`, focused TypeScript check, diff/self-review를 실행하고 명백한 문제를 수정한다.

## 후속 과제

- Pi tool API가 명시적인 confirmation hook을 제공하면 `confirm-write` 정책을 실제 confirmation flow로 승격한다.
- Setup Doctor가 runtime safety policy ledger 요약을 진단 출력에 포함할지 검토한다.
