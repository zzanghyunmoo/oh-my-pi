---
date: 2026-06-27
topic: setup-doctor-command-palette
source: docs/plans/2026-06-27-oh-my-pi-local-pi-distribution-parallel-work-plan.md
artifact_type: implementation-plan
status: implemented
---

# Setup Doctor + Command Palette 구현 계획

## 목표

Batch 1 / Idea 2의 MVP로, 설치 직후 사용자가 `/oh-my-pi-doctor`로 로컬 설정 상태를 안전하게 확인하고 `/oh-my-pi`로 사용 가능한 oh-my-pi 명령을 가볍게 탐색할 수 있게 한다.

## 범위

- 새 Pi extension `extensions/setup-doctor` 추가
- `package.json`의 `pi.extensions`에 새 extension만 등록
- read-only/time-bounded 진단만 수행
- 기존 `env-loader`, `quotio-provider`, `workspace-connectors` 구현은 수정하지 않음

## 구현 항목

1. `/oh-my-pi-doctor`
   - CWD `.env` 존재 여부와 경로 표시
   - `ENABLE_QUOTIO`, `ENABLE_WORKSPACE_CONNECTORS` 토글 상태 표시
   - `QUOTIO_BASE_URL`, `QUOTIO_API_KEY` 설정 여부 표시(값은 노출하지 않음)
   - Quotio가 활성화되고 필수 env가 있으면 `/models`에 제한 시간 내 read-only 연결 확인
   - `gh auth status`를 제한 시간 내 실행해 GitHub CLI 인증 상태 요약
   - `.env`, `.mcp-auth`, `auth.json`, `sessions/`, `~/.pi/agent/auth.json`, `~/.pi/agent/sessions/`가 local-only임을 리마인드
2. `/oh-my-pi`
   - Doctor, Quotio, workspace connector 명령의 짧은 팔레트/도움말 표시
3. 자체 리뷰/검증
   - TypeScript `--noEmit` 체크
   - diff 검토 후 불필요한 범위 확장 제거
