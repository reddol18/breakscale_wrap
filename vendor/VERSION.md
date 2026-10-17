# Breakscale 고정 버전

| 항목 | 값 |
|---|---|
| 원본 | https://github.com/xevrion/breakscale (MIT) |
| 고정 커밋 | `d2c876e0e17e79447bb81de071ef3b820d88f1a4` (2026-09-29, "docs: credit the Vercel open source program") |
| 클론 위치 | `vendor/breakscale/` — 수정 금지, 이 저장소의 git에는 넣지 않음(.gitignore) |
| 확인 환경 | Bun 1.2.19 / Node 24.12.0, Windows 10 |
| 받기·빌드 | `node lab/setup.mjs` (아래 수동 절차와 같음) |
| 회귀 기준 | `lab/fixtures/official/S1·S2` — 이 커밋의 공식 MCP `create_view` 응답 23건. 호스팅 MCP 응답과도 글자 단위로 23/23 같았음(2026-10-16) |

## 수동 절차
```
git clone https://github.com/xevrion/breakscale.git vendor/breakscale
git -C vendor/breakscale checkout d2c876e0e17e79447bb81de071ef3b820d88f1a4
cd vendor/breakscale       && bun install --frozen-lockfile
cd vendor/breakscale/mcp   && bun install --frozen-lockfile && bun run build
npm install && npx playwright-core install chromium
```
웹 앱까지 로컬로 띄우려면 `vendor/breakscale`에서 `bun run build` 후 `bun run preview --host 127.0.0.1 --port 4173`.

Claude Code는 저장소 루트의 `.mcp.json`으로 로컬 MCP(`node vendor/breakscale/mcp/dist/index.js --stdio`)를 쓴다.

## 업그레이드 절차
1. `lab/setup.mjs`의 `COMMIT`과 이 파일의 고정 커밋을 새 커밋으로 바꾸고 `node lab/setup.mjs`를 다시 돌린다(웹과 MCP는 항상 같은 커밋).
2. `bun lab/regress.ts`로 23건을 비교한다. 다르면 무엇이 바뀌었는지 확인하고, 엔진 결과가 바뀐 것이 맞으면 새 응답으로 `lab/fixtures/official/`을 갱신한다.
3. `bun lab/verify_cpu.ts`, `verify_oom.ts`, `verify_fleet.ts`로 lab 모델이 그대로 맞는지 본다.

## 외부 접속 (원본 웹·MCP)
- 원본 웹은 상단 GitHub 별 수 표시용으로 `GET https://api.github.com/repos/xevrion/breakscale` 1건을 보낸다. 설계 데이터는 담기지 않는다.
- MCP `create_view` 링크는 로컬에서 만들어지며 네트워크를 쓰지 않는다. 링크 주소는 `https://breakscale.tech/`로 고정이고, 열면 설계가 그 사이트로 간다(링크 조각 안의 데이터).
- `open_design`에 짧은 링크(`?s=`)를 넣을 때만 links.breakscale.tech에 접속한다.
- lab 쪽(`lab/`)은 네트워크를 쓰지 않는다(`lab/setup.mjs`의 clone·install 제외).
