# pi-quiet-ask

[English](README.md) | [한국어](README.ko.md)

**TypeSafe Jev를 pi 코딩 에이전트의 조용한 판단 레이어로.**

메인 LLM은 코드를 계속 쓴다. [Jev](https://typesafe.ai)는 텍스트 대신 타입 있는 확률을 ~250 ms에
돌려주는 System One 모델이다. 하네스가 세션마다 수십 번 내려야 하는 닫힌 질문만 맡긴다.
*이 명령은 파괴적인가? 저 출력에 키가 새었나? 에이전트가 막 물어보려는 답을 대화가 이미 정했나?
방금 "완료"라고 한 것을 검증했나?* 모든 답은 기록되고, 개입은 모두 선택이며, 전부 fail-open이다.

이 패키지 대부분은 작은 **규칙 엔진**이다. *팩(pack)* 하나가 pi 훅, 보낼 state, Jev에 물을 질문,
그리고 `if <답에 대한 조건식> then <행동>` 규칙을 선언한다. 내장 팩은 다섯 개이고, JSON 파일로
직접 추가할 수 있다. 행동이 특수한 판정기 둘은 팩이 아니다.
[`@eko24ive/pi-ask`](https://github.com/eko24ive/pi-ask) 질문을 선별하는 **triage**,
그리고 매 턴이 작업의 어느 단계인지 추적하는 **task graph**.

| 이름 | pi 훅 | Jev 질문 | 기본 행동 |
|---|---|---|---|
| `gate` | `tool_call` (bash/write/edit) | 파괴? 유출? 범위 밖? 피해 정도 | shadow → 경고 |
| `output` | `tool_result` (bash) | 시크릿 유출? 실패 종류? | 결과에 주석 |
| `intent` | `before_agent_start` | 어떤 종류의 작업? 모호한가? | 태그 + 푸터 |
| `honest_finish` | `agent_end` | 완료 주장? 검증됨? 완곡한가? | shadow → 경고 |
| `stuck` | `turn_end` (실패 포함) | 같은 실패가 반복? 여기서 고칠 수 있나? | shadow → 경고 |
| `graph` | `turn_end` | 어느 단계? 진전? 이탈? | HUD + 검증 생략 시 조향 |
| `triage` | `tool_call` (ask_user) | 문맥이 이미 고르는 옵션은? | 추천 / 자동응답 |
| `jev_ask` | 툴 | 모델이 묻는 것 | 답 |
| `evidence` | (Jev 호출 없음) | — | 작업 상태 JSON 장부 |

## 설치

```bash
# pi >= 0.85 와 TypeSafe API 키 필요
pi install git:github.com/HyunjunJeon/pi-quiet-ask
export TYPESAFE_API_KEY=...        # 또는 ~/.pi/agent/pi-quiet-ask.json, 또는 <project>/.env

# 선택: 선별이 붙는 ask_user 툴
pi install npm:@eko24ive/pi-ask

# 이 저장소를 클론한 뒤 한 번만 시험
pi -e ./extensions/quiet-ask/index.ts
```

같이 실리는 **`quiet-ask`** 스킬은 pi 에이전트용이다. 루프가 볼 수 있는 흔적을
남기고, 닫힌 질문만 던지고, state는 많이가 아니라 질문에 맞게 보내라고 가르친다.
Claude Code, Codex 등 pi가 아닌 에이전트는
[`HyunjunJeon/jev-judgment`](https://github.com/HyunjunJeon/jev-judgment)
(`npx skills add HyunjunJeon/jev-judgment`)를 쓴다.

키가 없으면 확장은 아무것도 등록하지 않고 비용도 없다. 키가 있으면 푸터에
`quiet packs:5 triage:auto graph`가 보이고, `/quiet`가 전체 상태를 출력한다.

![설치 후 idle 푸터와 빈 그래프 HUD](docs/screenshots/01-graph-idle.png)

## 팩

### 구조

E2E에서 쓴, 히스토리 재작성을 막는 프로젝트 팩
(`<project>/.pi/pi-quiet-ask/packs/force.json`):

```json
{
  "name": "force_push",
  "description": "Project rule: never rewrite shared git history from the agent",
  "on": "tool_call",
  "when": { "tool": ["bash"] },
  "mode": "enforce",
  "state": ["cwd", "arguments"],
  "questions": {
    "rewrites_history": { "noul": "Does this command rewrite or delete shared git history (force push, branch deletion on a remote, reset of a pushed branch)?" }
  },
  "rules": [
    { "name": "rewrite", "if": "rewrites_history >= 0.8",
      "then": { "do": "block", "say": "Blocked by project pack force_push (p={rewrites_history}): rewriting shared history is not allowed from the agent." } }
  ],
  "summary": "{label} rewrites={rewrites_history}"
}
```

이 파일이 있으면 `git push --force origin main`은 히스토리에
`force_push  block  enforce  git push --force origin main rewrites=0.97 [rewrite]`로 남고,
모델은 실행 대신 "Blocked by project policy"를 보고한다. 내장 게이트는 여전히 shadow라
같은 호출을 `shadow:confirm … [destructive,exfiltration]`로 기록한다.

| 필드 | 의미 |
|---|---|
| `on` | `tool_call` · `tool_result` · `before_agent_start` · `turn_end` · `agent_end` |
| `when` | Jev 호출 전 싼 필터: `tool: [..]`, `is_error`, `min_output_chars` (tool_result), `min_turn_index`, `has_error` (turn_end) |
| `mode` | `shadow`(기본): 개입 행동은 경고만 · `enforce`: 실제로 실행 |
| `state` | 보낼 소스. 나가기 전에 마스킹·절단된다 |
| `cacheSeconds` | 같은 state + 질문을 이 초 동안 한 번만 판정 (gate는 120) |
| `vars` | 규칙이 `vars.x`로 읽는 숫자. 팩을 복사하지 않고 설정에서 덮어쓸 수 있다 |
| `questions` | `{ "noul": "…" }` · `{ "choice": "…", "options": { label: description \| null } }` · `{ "score": "…", "levels": [..] }` |
| `rules` | 순서대로. `if`가 참인 규칙의 행동이 모두 쌓인다. `allow`는 평가를 멈춘다 |
| `summary` / `status` | 히스토리 한 줄과 푸터용 템플릿. `{path}`는 스코프 값을 끼워 넣는다 |

**state 소스.**

| 소스 | 내용 |
|---|---|
| `cwd` | 현재 작업 디렉터리 |
| `user_request` | 이번 사용자 요청 |
| `last_user_message` | 마지막 사용자 메시지 |
| `recent_turns` | 최근 6턴, 각 600자. 시스템 프롬프트 제외 |
| `tool` | 호출된 툴 이름 |
| `arguments` | 툴 인자 |
| `output` | 툴 출력 앞 `outputChars`자 |
| `is_error` | 툴이 에러로 끝났는지 |
| `prompt` | `before_agent_start`의 프롬프트 |
| `assistant_text` | 그 턴의 어시스턴트 텍스트 |
| `turn_tools` / `run_tools` | 툴 요약: 이름, 짧은 인자, 에러 여부, 출력 앞 300자 |
| `recent_failures` | 브랜치에서 실패한 최근 5회 |
| `turn_index` | 현재 턴 번호 |
| `graph` | 작업 그래프 스냅샷 |
| `evidence` | 현재 프롬프트 장부: 상태, 바뀐 파일, 마지막 검증, 페이즈, 불변식, 마지막 최종 메시지 |

**조건식.** 질문 id만 쓰면 대표값이다 — noul 확률, 선택된 라벨, 또는 score.
그래서 규칙은 임계값처럼 읽힌다: `destructive >= vars.destructive`,
`failure_class == "transient" and failure_class.confidence >= 0.6`, `intent.p.debug > 0.4`,
`not is_error`. `and`/`or`/`not`, 괄호, `== != < <= > >=`. 없는 경로는 `undefined`이고
비교는 거짓이다. 코드를 호출할 방법은 없다.

답 외에 스코프에 있는 값:

| 경로 | 의미 |
|---|---|
| `vars` | 팩 변수 (`vars.x`) |
| `tool` | 툴 이름 |
| `is_error` | 에러 여부 |
| `redactions` | 로컬에서 지운 자격증명 수 |
| `turn_index` | 턴 번호 |
| `run_edits`, `run_errors`, `run_tool_count`, `turn_edits`, `turn_errors` | 툴 궤적 횟수 |
| `files_changed`, `verifications`, `verified_after_change` | 장부 사실 |

**행동.**

| 행동 | 훅 | 효과 |
|---|---|---|
| `block` | tool_call | 툴을 실행하지 않음. `say`가 모델이 보는 이유 |
| `confirm` | tool_call | 사용자에게 물음 (`ctx.ui.confirm`). 헤드리스는 `headlessConfirm` (`warn` 또는 `block`) |
| `annotate` | tool_result | 모델이 읽는 툴 결과에 `say`를 덧붙임 |
| `steer` | turn_end, agent_end | 에이전트에 메시지 주입 (중간은 `steer`, 런 끝은 `followUp`). `maxPerPrompt`로 횟수 제한, 기본 1 |
| `set_thinking` | before_agent_start, turn_end | `pi.setThinkingLevel(level)` |
| `set_tools` | tool_call, before_agent_start | `pi.setActiveTools([...])` |
| `warn` | 전부 | 알림 |
| `status` | 전부 | 푸터 텍스트 |
| `tag` | 전부 | 히스토리 레코드에 라벨 (예: `{intent}`) |
| `allow` | 전부 | 이후 규칙 평가 중단 |

| 종류 | 행동 | shadow에서 |
|---|---|---|
| 개입 | `block`, `confirm`, `steer`, `set_thinking`, `set_tools` | "would block …"으로만 보고되고 `shadow:block`으로 기록. 그 외에는 아무 일도 없다 |
| 항상 | `annotate`, `warn`, `status`, `tag` | 두 모드 모두 실행 |

### 팩이 오는 곳

| 우선 | 위치 | 조건 |
|---|---|---|
| 1 | 내장 (아래) | — |
| 2 | `~/.pi/agent/pi-quiet-ask/packs/*.json` | — |
| 3 | `<project>/.pi/pi-quiet-ask/packs/*.json` | 신뢰된 프로젝트만 |
| 4 | 설정 `packs.<name>` | `on`과 `questions`가 있는 객체 |

같은 이름은 나중 정의가 앞을 대체하므로, 프로젝트가 내장을 통째로 바꿀 수 있다.
숫자 하나만 바꾸려면 덮어쓴다:

```json
{
  "packs": {
    "gate": { "mode": "enforce", "vars": { "destructive": 0.95 } },
    "stuck": { "enabled": false }
  }
}
```

검증에 실패한 팩은 건너뛰고 `/quiet`에 이름이 나온다 (`pack errors: …`). 세션을 깨지 않는다.

### 내장 팩

#### `gate`

`bash`, `write`, `edit`의 `tool_call`. 한 요청에 질문 넷: `destructive`,
`exfiltration`, `beyond_scope` (noul)와 `impact` (score 0–3: 없음 / 경미 / 중대 / 심각).
`destructive >= 0.9`, `exfiltration >= 0.7`, `beyond_scope >= 0.85`, 또는
`impact >= 2.5 and impact.confidence >= 0.5`이면 `confirm`. 120초 캐시. 임계값은
[y0usaf/pi-jev](https://github.com/y0usaf/pi-jev) 보정을 따른다. 요청된 일반 수정은
`destructive`가 ~0.85까지 나온다. 기본은 shadow. 실제로 물으려면 `/quiet pack gate enforce`.

![gate shadow: find -delete 는 실행되고 would confirm 만 남음](docs/screenshots/02-gate-find-delete.png)

#### `output`

`bash`의 `tool_result`. `leaks_secret` (noul)과 `failure_class` (choice:
no_failure, transient, environment, code_bug, permission, user_error). 유출은
`redactions > 0 or leaks_secret >= 0.9` — 로컬 패턴이 알려진 키 형태를 잡고 Jev가
나머지를 읽는다 — 그리고 "값을 반복하지 마라"를 덧붙인다. confidence ≥ 0.6인 실패
종류마다 조언 한 줄을 덧붙인다. 절대 막지 않는다.

| `failure_class` | 조언 |
|---|---|
| `transient` | 그대로 한 번 재시도 |
| `environment` | 코드가 아니라 머신을 고침 |
| `permission` | 사용자에게 물음 |

#### `intent`

`before_agent_start`. `intent` (choice: question, small_edit, feature, debug,
refactor, explore, chore, other)와 `ambiguous` (noul). 클래스 태그·푸터. `ambiguous >= 0.75`이면
경고. enforce에서 `debug`/`feature`는 thinking을 `high`로, `question`은 `low`로 둔다.

#### `honest_finish`

`agent_end`. 최종 메시지와 런의 툴 궤적에 대해 `claims_done`, `verified`,
`hedged` (noul). `run_edits > 0 and claims_done >= 0.7 and verified <= 0.35 and hedged < 0.5 and not verified_after_change`일 때만 발화한다.
Jev의 읽기와 장부의 사실이 맞아야 하고, 그때 조향한다: *"완료라고 보고했지만 마지막 변경 이후
검증이 없습니다 … 지금 해당 검사를 실행하세요"*. 프롬프트당 한 번.

![검증 없이 끝난 턴: honest_finish shadow 경고와 implement HUD](docs/screenshots/03-graph-after-turn.png)

#### `stuck`

`turn_end`. 세 번째 턴부터, 그 턴에 실패한 호출이 있을 때만.
`repeat_failure`와 `fixable_locally` (noul). 고칠 수 있으면 접근을 바꾸라고, 아니면
멈추고 사용자에게 물으라고 조향한다. 프롬프트당 각각 최대 2 / 1회.

## 작업 그래프

Jev는 노드 이름을 지어내지 못하므로 그래프는 작업마다 생성하지 않는다. 모든 코딩 런을
같은 여섯 단계에 읽는다.

```
clarify → explore → plan → implement → verify → report
```

매 `turn_end`에 Jev는 그 턴의 툴 요약, 어시스턴트 텍스트, 지금까지의 경로를 받고
`phase` (choice), `progress` (noul), `drift` (noul)로 답한다. 트래커는 방문·전이를
세고, 에디터 위에 상자 다이어그램 HUD를 그린다. 지금 칸은 붉은색, 이미 밟은 칸은
취소선, 아직 안 간 칸은 흐리게. 경로는 **세션 단위**다. 새 프롬프트는 다음 장이지
리셋이 아니다. 상자 아래에는 직전/현재 프롬프트의 장부 사실(`verified` /
`unverified`, 마지막 파일이나 검사)을 찍는다. Jev 라벨만 보여 주지 않는다.
불변식 셋을 코드로 검사한다.

| 불변식 | 발화 조건 | enforce 조향 |
|---|---|---|
| `report_without_verify` | implement는 방문, verify는 없음, 이번 턴이 report | 보고 전에 검사를 실행 |
| `explore_loop` | `exploreLoop`(4)턴 연속 explore이고 progress < `stalled`(0.4) | 계획을 정하거나 막는 질문 하나를 물어라 |
| `drift` | `drift >= 0.8`이 두 턴 연속 | 요청으로 돌아가라 |

HUD는 입력창 위에 있다. 지금 칸은 붉은색, 밟은 칸은 점이 남는다. 상자 아래 장부가
`prev` / `now` / `session`을 찍는다. 직전 칸, 지금 칸, 그 스텝이 `verified`인지
`skip`/`drift`인지를 보여 준다. `/quiet evidence`가 같은 `moves` 기록을 덤프한다.

시작 — 여섯 칸이 비어 있고 첫 턴을 기다린다.

![세션 시작 Graph HUD](docs/screenshots/01-graph-idle.png)

첫 프롬프트가 `evidence_demo.py`를 쓰고 끝났다고 했다. 그래프가 `report_without_verify`로
조향했고 `python3 evidence_demo.py`가 돈 뒤 HUD는 **verify**에서 `now verified`가 됐다.

![검증을 건너뛴 뒤 조향하고 now verified로 기록](docs/screenshots/04-graph-now-verified.png)

두 번째 프롬프트는 리셋이 아니라 다음 장이다. `prev`는 첫 파일, `now`는 `second_demo.py`.
지금 칸은 붉은 `report`다.

![두 번째 프롬프트 이후 prev와 now](docs/screenshots/05-graph-prev-and-now.png)

`/quiet evidence` — `implement→report skip`, `report→verify ok` 등 세션 `moves`와 `fit`.

![/quiet evidence의 from→to moves와 fit](docs/screenshots/06-quiet-evidence-moves.png)

`/quiet graph`는 경로, 턴별 표, 전이 횟수를 출력한다. 기본은 enforce: 검증을 건너뛰거나
탐색이 루프되거나 이탈이 두 턴 연속이면 불변식당 프롬프트당 한 번 조향한다.
`/quiet graph shadow`는 HUD와 히스토리만 남기고 런은 바꾸지 않는다. 팩은
`"state": ["graph", …]`로 그래프를 읽을 수 있다.

## 증거 장부

`history.jsonl`은 *Jev가 뭐라고 했는지*를 답하고, 장부는 *작업 상태가 무엇인지*를 답한다.
Jev를 호출하지 않는다. 사용자 프롬프트마다
`~/.pi/agent/pi-quiet-ask/evidence/<sessionId>.json`에 다음이 남는다.

| 필드 | 출처 | 내용 |
|---|---|---|
| `request`, `intent` | 입력 훅, intent 팩 | 프롬프트(600자)와 클래스 |
| `files_changed` | `tool_result` | 모든 `write` / `edit`: 런, 턴, 경로, 에러 여부 |
| `commands` | `tool_result` | 모든 `bash`와 출력 앞 300자. 결정적으로 분류: `test`, `typecheck`, `lint`, `build`, `run`, `other` |
| `verifications` | 파생 | 검사 명령. 각각 `passed`와 `after_last_change`(이후 수정이면 false) |
| `phases`, `invariants` | 작업 그래프 | 턴별 phase / progress / drift, 발화된 불변식 |
| `moves` | 그래프 + 장부 사실 | 세션 `from→to` 로그. 파일/검사와 결정적 `fit`(`ok` / `skip` / `loop` / `drift` / `mismatch`). 나중에 그 스텝이 적절했는지 평가할 때 씀 |
| `runs` | `agent_end`, honest_finish 팩 | 각 런의 최종 메시지 앞부분. 판정되면 `claims_done` / `verified` / `hedged` |
| `decisions` | 히스토리 리스너 | 사소하지 않은 Jev 결정(block, confirm, steer, 자동응답, 추천, 주석)과 결과, `agreed` |
| `status` | 파생 | `no_changes` · `in_progress` · `verified` · `unverified`(검증 없이 런이 끝남) · `blocked` |

파일은 변경마다 원자적으로 다시 쓰이고, 세션의 최근 50개 프롬프트를 담으며, 같은 세션을 재개하면
다시 읽는다. 각 파일은 `$schema`로 [`schemas/evidence.schema.json`](schemas/evidence.schema.json)을
가리키므로 에디터에서 검증하거나 스크립트로 장부를 일반 JSON처럼 다룰 수 있다.
`/quiet evidence`는 현재 프롬프트의 장부를 출력한다. E2E — *hello.py를 쓰고 실행하지 않은 채
동작한다고 주장* — 에서 장부는 이렇게 끝났다.

```json
{
  "status": "verified",
  "files_changed": [
    { "run": 1, "turn": 0, "tool": "write", "path": ".../hello.py" }
  ],
  "verifications": [
    { "run": 2, "kind": "run", "command": "python3 hello.py", "passed": true, "after_last_change": true }
  ],
  "phases": ["implement", "report", "verify", "verify"],
  "invariants": [{ "name": "report_without_verify", "turn": 1 }],
  "runs": [
    { "final_text": "Done — hello.py is written and works.", "claims_done": 0.99, "verified": 0.02 },
    { "final_text": "Verified by running `python3 hello.py`; it printed `hello`.", "claims_done": 0.94, "verified": 0.93 }
  ],
  "decisions": [{ "kind": "honest_finish", "action": "steer" }]
}
```

팩은 `"state": ["evidence"]`로 읽고 규칙에서 사실을 검사할 수 있다. `honest_finish`는 이미
조향 전에 `not verified_after_change`를 요구한다. `"evidence": { "file": false }`로 끄거나
`"evidence": { "dir": "~/work/ledgers" }`로 옮긴다.

## 선별 (`@eko24ive/pi-ask`)

모델이 `ask_user`를 호출하면, 단일 선택 질문마다 *대화가 이미 정하는 옵션은 무엇인가?*를
명시적 `ask_user` 옵션과 함께 묻고, "애초에 정해졌는가?"도 묻는다. 그다음:

| Jev | 선별의 동작 |
|---|---|
| 옵션 p ≥ 0.9 **그리고** determined ≥ 0.9 (`auto` 모드) | 옵션을 recommended로 표시하고, pi-ask가 폼을 열면 이벤트 계약으로 제출한다. 사용자를 묻지 않았다는 메모를 남긴다 |
| 옵션 p ≥ 0.5 | `recommended`로 표시하고 제목 앞에 `Jev suggests: pnpm 0.75`. 사용자가 답한다 |
| `ask_user` 또는 그 이하 | 손대지 않음 |

![선별 suggest: 폼이 열리고 pnpm 이 recommended](docs/screenshots/07-triage-suggest.png)

![선별 auto: 폼을 보여 주지 않고 대화에서 제출](docs/screenshots/08-triage-auto.png)

다중 선택과 자유 텍스트는 자동응답하지 않는다. pi-ask가 끝나면 레코드를 갱신하므로
`/quiet history triage`에서 Jev의 선택과 최종 답, 둘이 **일치했는지**를 본다. 임계값이
맞는지 알려주는 숫자다. 모드: `/quiet triage off|suggest|auto`.

## `jev_ask`

모델이 직접 쓰는 툴:
`jev_ask({ state, questions: [{ id, type: "noul" | "choice" | "score", instructions, options? | levels? }] })`.
닫힌 결정을 산문으로 고민하는 대신 Jev의 보정된 답을 받는다 (호출당 최대 16질문).
다른 것과 같이 기록된다 (`/quiet history jev_ask`).

## 명령

| 명령 | 설명 |
|---|---|
| `/quiet` | 상태: 팩, 그래프, 선별, Jev 호출 통계, 팩 오류, 파일 경로 |
| `/quiet on\|off` | 모든 팩 + 그래프 (선별은 별도 스위치) |
| `/quiet packs` | 팩당 한 줄: 훅, 모드, 출처, 규칙, 횟수 |
| `/quiet pack <name>` | 팩의 규칙 보기. `… on\|off\|shadow\|enforce`로 변경 |
| `/quiet mode shadow\|enforce` | 모든 팩 + 그래프를 한 번에 |
| `/quiet triage off\|suggest\|auto` | 선별 모드 |
| `/quiet graph [on\|off\|shadow\|enforce]` | 인자 없으면 그래프 출력 |
| `/quiet evidence` | 현재 프롬프트의 장부와 파일 경로 |
| `/quiet last [pack]` | 팩의 마지막 판정 (기본 gate) |
| `/quiet check <command>` | 실행하지 않고 gate 팩으로 명령을 판정 |
| `/quiet history [kind]` | 이 브랜치의 결정을 골라 답, state, 결과 보기 |

## 설정

`~/.pi/agent/pi-quiet-ask.json`, 그다음 `<project>/.pi/pi-quiet-ask.json` (신뢰된 프로젝트).
파일이 지정한 키만 덮어쓴다. 기본값:

```json
{
  "model": "jev-latest",
  "timeoutMs": 4000,
  "maxStateChars": 8000,
  "argumentChars": 400,
  "outputChars": 2000,
  "headlessConfirm": "warn",
  "packs": {},
  "triage": { "mode": "auto", "autoAnswer": 0.9, "suggest": 0.5, "note": true },
  "graph":  { "enabled": true, "mode": "shadow", "hud": true, "exploreLoop": 4, "drift": 0.8, "stalled": 0.4 },
  "history": { "file": true, "keepState": true },
  "evidence": { "file": true }
}
```

키는 아래 순서로 찾고, 알림·히스토리 줄·조향 메시지에서는 지워진다.

1. `TYPESAFE_API_KEY` 환경변수
2. `apiKey`
3. `apiKeyFile`
4. `<cwd>/.env`

## 히스토리

모든 판정은 두 곳에 남는다. `pi-quiet-ask:decision` 세션 엔트리(브랜치 인식, LLM 컨텍스트 밖)와
`~/.pi/agent/pi-quiet-ask/history.jsonl`. 결과(확인 승인/거절, 선별 최종 답)는 나중에
`…:outcome`으로 덧붙는다.

| 필드 | 내용 |
|---|---|
| `kind` | 팩 이름 |
| `action` | 행동 |
| `mode` | `shadow` / `enforce` |
| `summary` | 히스토리 한 줄 |
| `answers` | 원본 Jev 답 |
| `latencyMs` | 지연 |
| `cached` | 캐시 히트 여부 |
| `state` | 실제로 보낸(마스킹된) state |

```bash
jq -r '[.at[11:19], .kind, .action, .mode, .summary] | @tsv' ~/.pi/agent/pi-quiet-ask/history.jsonl | tail
jq -c 'select(.kind=="triage" and .outcome) | {summary, agreed: .outcome.agreed}' ~/.pi/agent/pi-quiet-ask/history.jsonl
```

## 기계를 떠나는 것

- 팩이 나열한 state만 나간다.
- 알려진 자격증명 형태는 `<REDACTED:kind>`로 바뀌고 `redactions`에 센다.
- 문자열은 `argumentChars` / `outputChars`, 전체는 `maxStateChars`에서 자른다.
- 요청은 `timeoutMs`에 재시도 없이 타임아웃한다. 타임아웃, 4xx/5xx, 잘못된 응답은
  *판정 없음*이고, pi는 원래대로 동작한다.
- 오류는 분당 한 번만 알린다.
- 같은 요청은 in-flight를 공유하고, 팩이 `cacheSeconds`를 두면 답도 한 번만 받는다.

## 선행 작업

- [y0usaf/pi-jev](https://github.com/y0usaf/pi-jev) — pi용 첫 Jev 게이트. 게이트 질문 넷,
  임계값, 마스킹/절단, 캐시, `jev_ask` 툴을 여기서 팩으로 다시 썼다.
- [DevMortimer/pi-typesafe](https://github.com/DevMortimer/pi-typesafe)와
  [AbdelStark/bicameral](https://github.com/AbdelStark/bicameral) — 같은 아이디어의 병행 시도.
- [eko24ive/pi-ask](https://github.com/eko24ive/pi-ask) — 선별이 올라가는 `ask_user` 툴과
  이벤트 계약. 이 패키지는 자체 질문 UI를 만들지 않는다.

여기서 새로운 것:

- 선언적 규칙 엔진과 사용자 팩
- `before_agent_start` / `turn_end` / `agent_end` 판정기 (`intent`, `honest_finish`, `stuck`)
- 작업 그래프
- pi-ask를 대체하지 않는 선별
- 결과까지 이어 기록되는 결정 히스토리

## 개발

```bash
npm install --ignore-scripts && npm run check      # tsc --noEmit
pi --no-extensions -e ./extensions/quiet-ask/index.ts
```

런타임 의존성: `@typesafe-ai/sdk`. `@earendil-works/*`와 `typebox`는 pi가 제공한다.

## 벤치마크

`bench/`는 이 확장이 묻는 같은 닫힌 질문(`tool_gate`, `agent_question`)에서 Jev와
채팅 LLM 넷을 비교한다. 데이터, 라벨, 마지막 실행은 커밋되어 있다.
재현은 [`bench/README.md`](bench/README.md):

```bash
cd bench && uv sync --all-groups
uv run jev-bench                                  # 두 task, Jev + 4 LLM, 3회
uv run jev-bench --task agent_question --no-llm   # Jev만
uv run pytest -q && uv run ruff check src tests && uv run mypy src
```

전체 표: [`bench/results/REPORT.md`](bench/results/REPORT.md).

## 라이선스

MIT.
