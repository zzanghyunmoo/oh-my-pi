---
date: 2026-06-27
topic: profile-pack-lockfile
artifact_type: implementation-plan
status: implemented
---

# Profile Pack + Lockfile 구현 계획

## 목표

Batch 3 / Idea 1의 범위를 `oh-my-pi` 배포 재현성 레이어로 한정한다. 커밋 가능한 프로필 팩은 어떤 Pi 패키지, 익스텐션 토글, secret reference, connector/provider 기본값, prompts/themes 의도를 설치해야 하는지 설명하고, lock/receipt는 그 의도를 secret 값 없이 재현 가능한 형태로 고정한다.

## 범위

1. `docs/profiles/`에 commit-safe 프로필 스키마와 `default`, `workspace`, `proxy-provider`, `full` 프로필을 추가한다.
2. 기존 `docs/blueprints/oh-my-pi.secret-blueprint.json`, `package.json`의 Pi package metadata, connector/provider/capability metadata 파일 경로를 프로필에서 참조한다.
3. `npm:pi-clear` 최근 수동 설치 신호와 기존 `settings.example.json` 외부 Pi package 의도를 프로필/lock에 기록한다.
4. `scripts/profile-pack.mjs`로 read-only verify, deterministic lock 생성, dry-run apply 안내를 제공한다.
5. README 설치/검증 흐름에 `profile:verify`와 dry-run apply 사용법만 최소 추가한다.

## 비범위

- Pi 런타임 익스텐션 추가 또는 connector/provider 런타임 코드 변경.
- `.env`, OAuth state, auth 파일, local endpoint/API key 값 생성 또는 커밋.
- 기본 실행에서 `pi install`, 파일 쓰기, destructive operation 수행.

## 검증

- `npm ci`
- `npm run profile:verify`
- `node scripts/profile-pack.mjs apply --profile full`
- `node --check scripts/profile-pack.mjs`
- TypeScript 파일을 수정한 경우에만 focused TypeScript validation을 수행한다.
