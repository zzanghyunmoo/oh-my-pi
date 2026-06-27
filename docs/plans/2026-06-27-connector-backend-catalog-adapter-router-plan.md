---
date: 2026-06-27
topic: connector-backend-catalog-adapter-router
source: docs/plans/2026-06-27-oh-my-pi-local-pi-distribution-parallel-work-plan.md#batch-2--connector--provider-layer
artifact_type: implementation-plan
status: implemented
---

# Connector Backend Catalog + Adapter Router 구현 계획

## 목표

Linear/Notion OAuth MCP, GitHub gh CLI, Quotio provider처럼 backend 성격이 다른 통합을 하나의 typed catalog로 설명하고, workspace-connectors가 Linear/Notion MCP 연결 정보와 사용자 안내 문구를 로컬 상수 대신 catalog/router에서 읽게 한다.

## 범위

- 새 typed connector backend catalog를 추가한다.
- catalog 기반 adapter router helper를 추가한다.
- `extensions/workspace-connectors/index.ts`의 Linear/Notion 서비스 상수, URL, label, command usage, auth/status/fallback 문구를 router 호출로 대체한다.
- 기존 공개 명령/도구 이름은 유지한다: `/connector-login`, `/connector-tools`, `workspace_mcp_list_tools`, `workspace_mcp_call_tool`, `github_gh_cli`.
- `extensions/quotio-provider/index.ts`, `extensions/setup-doctor/index.ts`, `extensions/capability-registry.ts`는 충돌을 줄이기 위해 수정하지 않는다.

## 구현 단계

1. `extensions/connector-backend-catalog.ts`를 추가해 backend schema와 Linear/Notion/GitHub/Quotio catalog entry를 정의한다.
2. 같은 파일에 MCP remote route, gh CLI route, provider route를 반환하는 adapter router helper를 둔다.
3. workspace connector extension에서 catalog/router를 import하고 MCP client 생성, login command, list/call tool 안내, GitHub CLI 안전 가드를 catalog 기반 문구로 연결한다.
4. TypeScript 검증을 실행하고 명백한 중복/오류를 자체 리뷰로 정리한다.

## 후속 과제

- Setup Doctor와 Capability Registry가 connector catalog를 읽어 backend별 상태를 표시하도록 통합한다.
- Provider Adapter Kit 작업과 합류할 때 Quotio provider entry를 공통 provider capability contract에 매핑한다.
