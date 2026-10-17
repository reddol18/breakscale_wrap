# breakscale_wrap — Claude Code 작업 안내

이 저장소는 시스템 설계 시뮬레이터 Breakscale(원본, `vendor/breakscale/`)을 **고치지 않고** 감싸서
VM 단위 CPU 포화·부분 OOM·헬스체크·자체 오토스케일링을 덧붙인 도구다. 사용자는 자연어로
"이런 구성에 이런 트래픽이 오면 어떻게 되나"를 묻고, 너(Claude Code)는 그것을 **시나리오 파일**로 옮겨 돌린다.

## 규칙
1. `vendor/breakscale/`는 **절대 수정하지 않는다.** 원본은 import만 한다. 원본 동작이 부족하면 `lab/` 쪽에서 메운다.
2. 결과를 보고할 때 **엔진 실측**(슬롯·대기열·처리량·지연·실패, LB 분배)과 **lab 추정**(CPU·메모리·헬스체크 응답·증설/축소/재시작)을 구분한다.
3. 사용자가 실측값(부하 테스트·모니터링)을 주지 않은 값은 **가정값**이라고 밝히고, 어떤 값을 가정했는지 적는다.
4. 실제 회사·개인 정보가 담긴 설계는 공식 호스팅 서버(breakscale.tech, mcp.breakscale.tech)로 보내지 않는다. 이 저장소의 로컬 MCP(`.mcp.json`)와 로컬 실행만 쓴다.

## 처음 한 번
`vendor/breakscale/`가 없거나 `vendor/breakscale/mcp/dist/index.js`가 없으면 먼저 준비한다.
```
node lab/setup.mjs          # 원본을 검증한 커밋으로 받아 빌드 + 의존성 + Chromium
bun lab/regress.ts          # 23/23 same 이 나와야 정상
```
필요한 도구: git, Bun 1.2+, Node 20+, (녹화 시) ffmpeg.

## 자연어 요청 → 시뮬레이션 절차
1. **요청을 정리한다.** 서비스 구성(LB, API 서버, DB, 캐시 등), 트래픽 모양(일정·단계 상승·급증·감소),
   VM 사양, 앱 동작 값(처리 시간, 요청당 CPU, 요청당 메모리), 운영 방식(ALB/쿠버네티스, 헬스체크 구현, 오토스케일 정책).
   빠진 값은 아래 "기본값과 매핑"으로 채우고 가정이라고 말한다. 꼭 필요한 것만 사용자에게 묻는다.
2. **시나리오 파일을 쓴다:** `lab/scenarios/<이름>.json`. 형식은 `lab/core/scenario-file.ts` 머리말,
   예제는 `lab/scenarios/example_spike.json`(오토스케일링), `lab/scenarios/example_crash.json`(장애 주입).
3. **돌린다:** `bun lab/sim.ts <이름> --every 5` → 시각별 처리·실패·VM 상태, 사건 기록, 요약(요청·실패율·VM 대수 변화·VM-초).
4. **읽고 고친다.** 결과가 요청 의도와 다르면(예: 병목이 엉뚱한 곳) 값을 고쳐 다시 돌린다.
5. **보여준다(선택):** `node lab/viz/serve.mjs`를 백그라운드로 띄우고 `http://127.0.0.1:4180/?scn=<이름>` 안내.
   영상: `node lab/viz/record.mjs samples/lab/<폴더> <초> 30 <파일이름> "scn=<이름>"`(서버가 떠 있어야 함, ffmpeg 필요).
   스크린샷: `node lab/viz/shot.mjs samples/lab/<폴더> 10,30 "scn=<이름>"`.
6. **보고한다.** 무엇이 언제 터졌는지(사건 기록), 원인, 바꿔 볼 만한 설정, 그리고 가정값 목록.

공식 MCP 도구(`create_view` 등)는 설계 자체가 원본 엔진에서 어떻게 도는지 빠르게 볼 때 쓴다.
VM 단위 장애·오토스케일링은 공식 MCP 응답에 나오지 않으므로 반드시 `lab/sim.ts`로 돌린다.

## 설계 작성 요령
- `design`은 공식 MCP `create_view` 입력과 같다: `nodes[{id, kind, label, x?, y?, config}]`, `edges[{from, to}]`.
  자주 쓰는 kind: `client`(트래픽 원천, `config.rps`), `lb`, `service`, `db`, `cache`, `queue`, `worker`.
- **VM 단위로 보려면 VM 1대 = 노드 1개**(`instances: 1`)로 만들고 LB에 각각 연결한다.
  `instances: N`인 노드는 원본이 슬롯을 합쳐 계산해서 VM별 CPU·OOM을 표현할 수 없다.
- 자체 오토스케일러(`fleet`)를 쓰면 **최대 대수만큼 VM 노드를 미리 그려 둔다**(꺼진 VM은 화면에서 숨겨진다).
  화면 배치는 3열 × 2행(최대 6대)이 보기 좋다. `example_spike.json`의 x·y를 참고.
- 서비스 노드 `config`: `capacity`(동시 처리 슬롯), `serviceMs`(자기 처리 시간, 하류 호출 제외), `serviceCv`, `queueLimit`.
- DB 노드는 원본 기본값으로 `lockMs: 15`(쓰기 락 경합)가 들어간다. 의도가 없으면 `"lockMs": 0`을 명시한다.
- CPU 경합 모델은 `service` 노드에만 적용된다(원본의 slow 장애가 db 등에는 안 먹힘).

## 기본값과 매핑 (실측이 없을 때)
| 사용자가 말한 것 | 시나리오에 넣을 값 |
|---|---|
| "AWS ALB" | `fleet.failOpen: true` |
| "쿠버네티스", "Pod" | `recovery.mode: "container"`, `failOpen: false` |
| "VM 재시작 없이 프로세스만 재시작"(systemd) | `recovery.mode: "process"` |
| "오토스케일링 그룹이 불량 인스턴스를 교체" | `recovery.mode: "replace"` |
| "헬스체크 전용 엔드포인트/스레드" | `health.path: "dedicated"` (아니면 `"queued"`) |
| "CPU 60%에서 증설" | `scaling.metric: "cpu", target: 0.6` |
| "메모리 누수" | VM 사양에 `leakPerReqMiB`(요청당) 또는 `leakPerSecMiB` |
| 인스턴스 종류(c6i.large 등) | `vcpu`, `memMiB`를 그 사양으로 |

앱 동작 값이 전혀 없으면: `serviceMs` 20, `cpuPerReq` 0.5(CPU 위주 API) 또는 0.1(I/O 위주), `memBaseMiB`는 메모리의 25%,
`memPerInflightMiB` 24. 반드시 가정이라고 밝힌다.

## 단위
- 시나리오 `seconds`, `timeline[].at`: **초**
- `fleet` 안의 시간(`bootMs`, `health.intervalMs` 등): **밀리초**
- 메모리: MiB, CPU: vCPU 개수, `cpuPerReq`: 요청 하나가 자기 처리 시간 중 CPU를 쓰는 비율(0~1)
- 영상·예제는 시간을 압축해 둔 것이다(부팅 5초 등). 실제 예측에는 실제 시간을 넣는다.

## 검증 (lab 코드를 고쳤을 때)
```
bun lab/regress.ts       # 컨트롤러 없으면 공식 MCP 응답과 글자 단위로 같아야 한다
bun lab/verify_cpu.ts
bun lab/verify_oom.ts
bun lab/verify_fleet.ts
```
