# Tailscale 관제

Tailscale 장비를 자동 수집해 이름·태그 컨벤션 위반을 알리고, 누가 언제 어떤 경로로 장비를 등록·삭제했는지 기록하는 로컬 웹사이트입니다.

화면은 **장비 / 등록·삭제 이력 / 규칙·알림** 세 개입니다. 통계 상태판과 수동 승인 절차가 없습니다. 이 프로그램은 Tailscale의 장비·정책을 수정하지 않습니다.

## 로컬에서 먼저 보기

Node.js 24.16 이상(24.x)을 사용합니다. 외부 npm 패키지가 없어 `npm install`은 필요하지 않습니다.

프로젝트 폴더의 PowerShell에서:

```powershell
npm.cmd run demo
```

브라우저에서 **http://127.0.0.1:8787**을 엽니다. 예시 모드는 가상 데이터만 사용하며 Tailscale·Slack·Telegram 요청을 보내지 않습니다. 예시 설정은 서버를 재시작하면 초기화됩니다. 종료는 `Ctrl+C`입니다.

## 실제 연동

1. `.env.example`을 `.env`로 복사합니다.
2. Tailscale 관리 콘솔 → Settings → Trust credentials → OAuth에서 다음 두 **읽기 권한**을 선택합니다.
   - `devices:core:read`
   - `logs:configuration:read`
3. 예시 서버를 종료하고 `npm.cmd start`로 실행합니다.
4. 웹의 **규칙·알림 → 연동 설정 → Tailscale**에 Tailnet, Client ID, Client Secret을 입력하고 **Tailscale 저장**을 누릅니다. Tailnet 값은 Settings → General의 tailnet name입니다. 저장하면 재시작 없이 즉시 수집합니다. 권한이나 인증 오류는 화면에 표시됩니다.
5. **규칙·알림**에서 팀의 실제 규칙을 저장합니다. 기본 규칙은 임시값입니다. 알림을 처음부터 받지 않으려면 채널 인증정보를 넣기 전 **전체 알림**을 끄세요.

```powershell
Copy-Item .env.example .env
npm.cmd start
```

기본 주소는 http://127.0.0.1:8787 입니다. 브라우저를 닫아도 서버가 실행 중이면 기본 60초마다 수집합니다. 로컬 실행 터미널이나 PC를 종료하면 수집이 멈춥니다. 별도 공인 IP·도메인·Funnel은 필요하지 않습니다.

### 컨벤션

- **장비명 규칙:** Tailscale 콘솔의 장비명(MagicDNS 이름의 첫 부분)에 정규식을 적용합니다. OS의 원래 hostname은 별도로 표시합니다.
- **태그 종류:** 검사하지 않습니다. 새 태그는 정책 파일 tagOwners에 등록해야만 쓸 수 있으므로 태그가 늘어나면 장비 화면 그룹도 자동으로 늘어납니다.
- **예외 장비:** 장비 화면의 **알림 제외** 버튼으로 지정합니다(예: 사무실의 jetson 보드). 예외 장비는 검사와 알림에서 빠지며 **예외 해제**로 되돌립니다. Tailscale 노드 ID 기준이라 삭제 후 재등록한 장비는 다시 검사합니다.
- **알림 형식:** 제목, 시각(KST), 이름 규칙 위반과 태그 지정 위반 섹션, 하단 버튼(Tailscale 콘솔·모니터링 열기)으로 보냅니다. 모니터링 버튼 주소는 `.env`의 `MONITOR_PUBLIC_URL`입니다.
- **기본 장비명 규칙:** `jetson-지역-cough01`(축사), `chonnam-uni-001`(양계장), `닉네임-장비`(사무실). 사무실 형식은 `jetson-`·`chonnam-`으로 시작할 수 없어 축사·양계장 장비 오타를 놓치지 않습니다.
- **태그 없는 장비:** 옵션을 켜면 태그 미지정도 위반입니다.
- **장비명별 태그 규칙:** `접두어 = 정확히 사용할 태그` 형식이며 선택 사항입니다. 예: `jetson-hadong- = tag:pig`. 이 장비에 `tag:team-hardware`가 추가되면 규칙 위반으로 알립니다. 여러 태그는 쉼표로 구분합니다. 접두어가 겹치면 일치하는 규칙을 모두 검사합니다.
- **정규식 태그 규칙:** 규칙 왼쪽이 `^`로 시작하면 정규식으로 검사합니다. 예: `^[a-z0-9]+-office- = tag:office`, `^[a-z0-9]+-(?!office-)[a-z0-9]+- = tag:field` (장비-지역-닉네임에서 지역이 office면 office 태그, 아니면 field 태그). 정규식에 `=`는 쓸 수 없습니다.
- **사용자 그룹:** 장비 화면의 **+ 그룹 만들기**로 서버에 저장되는 보기용 그룹을 만듭니다(2단계까지, 예: team-hardware › 팀원별). 장비 행의 그룹 선택으로 옮기면 태그 그룹 대신 그 그룹에 표시됩니다. Tailscale 태그와 규칙 검사에는 영향이 없습니다.
- **변경 알림:** 감사 로그의 장비 등록·삭제, 태그·이름·키 만료 변경, 정책(ACL) 변경, 사용자·API 키 변경을 누가 했는지와 함께 이력에 남기고 Slack·Telegram으로 알립니다. 로그인과 이 모니터의 자체 토큰 발급은 제외합니다. 기능을 처음 켠 시점 이후 변경만 알리고, 규칙·알림의 "변경 알림"으로 끌 수 있습니다.

컨벤션을 지킨 새 장비는 별도 승인 없이 표시됩니다. 위반의 최초 발견·내용 변경·해소 후 재발 때 알림을 생성하며, 같은 위반이 유지되는 동안은 반복하지 않습니다. 최초 실제 수집 시 현재 존재하는 위반도 묶어서 알립니다. 장비 등록·삭제 자체는 이력에 남습니다.

### Slack·Telegram

`규칙·알림`에서 전체 및 채널별 ON/OFF를 즉시 저장합니다. 두 채널을 켜면 같은 알림을 양쪽으로 보냅니다. 채널을 켜거나 연동 정보를 저장하면 그 시점에 열려 있는 위반을 한 번 묶어서 보냅니다. 전송 실패로 이미 대기 중인 알림은 켜면 재시도합니다.

- **Slack:** 웹의 **연동 설정 → Slack**에 Incoming Webhook 주소를 입력하고 저장합니다.
- **Telegram:** BotFather에서 봇을 만들고 웹의 **연동 설정 → Telegram**에 Bot Token과 Chat ID를 입력하고 저장합니다. 개인 대화에서는 먼저 봇에게 `/start`를 보내고, 그룹에서는 봇을 추가해 메시지를 보낼 수 있게 해야 합니다. Chat ID는 숫자(그룹은 음수 가능) 또는 공개 채널의 `@채널명`입니다.

웹에서 저장한 연동 정보는 서버에 즉시 적용되며, 재접속·서버 재시작 후에도 유지됩니다. 기본 마스킹 상태로 표시하고, 각 항목의 **보기 / 숨기기**로 확인합니다. 수정하지 않은 항목은 보존하며, 값 전체를 비운 뒤 저장하면 해당 항목을 제거합니다(Tailscale 3개, Telegram 2개는 함께 입력하거나 비우세요). 보기 요청과 저장 요청은 기존 로그인 및 같은 사이트 요청 검사로 보호합니다.

값은 서버 데이터 폴더의 DB에 AES-256-GCM으로 암호화해 보관하며 같은 폴더의 `credentials.key`로 복호화합니다. 데이터 폴더와 키는 함께 백업하고 접근 권한을 제한하세요. 브라우저 localStorage와 일반 상태 응답에는 실제 값을 넣지 않고, 보기 버튼을 누른 항목만 조회합니다. Docker 이미지에는 저장값이나 키를 포함하지 않습니다. `.env` 연동 정보도 초기값으로 지원하지만, 웹에서 저장한 항목이 우선하며 `.env` 자체는 수정하지 않습니다.

채널 전송 실패는 개별 대기열에서 재시도하므로 다른 채널의 전송을 막지 않습니다. 수신 측 전송 성공 직후 프로세스가 중단되는 경우에는 재시도 메시지가 중복될 수 있습니다.

Telegram Chat ID를 모르면 봇에게 메시지를 보낸 뒤 본인의 환경에서 Bot API의 `getUpdates` 응답 내 `message.chat.id`를 확인하세요. 봇 토큰이 포함된 주소·응답을 공개하거나 채팅에 붙이지 마세요.

## Docker로 실행·업데이트

서버 폴더(예: `~/tailscale-monitoring`)에 `compose.yaml`, `.env`, `.data/`를 둡니다. 이미지는 사내 레지스트리 `<레지스트리>/<저장소>`에서 받습니다.

`.env`에 필요한 값:

| 키 | 설명 |
|---|---|
| `UPDATE_IMAGE` | 레지스트리주소/저장소 (태그 제외) |
| `MONITOR_TAG` | 실행할 버전. 웹 업데이트가 이 값을 바꿉니다 |
| `DOCKER_AUTH_FILE` | 서버에서 `docker login` 해 둔 `config.json`의 절대 경로. 새 버전 감지와 이미지 받기에 읽기 전용으로 씁니다 (`REGISTRY_USER`·`REGISTRY_PASSWORD`로 대신할 수도 있음) |
| `UPDATER_TOKEN` | 모니터링 ↔ 업데이터 내부 인증용 무작위 값(16자 이상) |
| `MONITOR_HOST_IP` | 포트를 열 서버의 Tailscale IP |
| `MONITOR_USER`, `MONITOR_PASSWORD` | 웹 로그인 |
| `MONITOR_ALLOWED_HOSTS`, `MONITOR_PUBLIC_URL` | 접속 주소와 알림 버튼 주소 |

```bash
docker login <레지스트리>
docker compose up -d
docker compose logs --tail=50 monitor updater
```

`.data`는 컨테이너의 `node` 사용자(uid 1000)가 쓸 수 있어야 합니다(`sudo chown -R 1000:1000 .data`).

### 새 버전

- 모니터링이 10분마다(`UPDATE_CHECK_SEC`) 레지스트리 태그를 확인합니다. 현재보다 높은 `x.y.z` 태그가 있으면 Slack·Telegram에 한 번 알리고 웹 상단에 **업데이트** 버튼을 띄웁니다.
- 버튼을 누르면 `updater` 컨테이너가 새 이미지를 받고 `.env`의 `MONITOR_TAG`를 바꾼 뒤 `monitor`만 다시 만듭니다. 기록은 `.data`에 남습니다. 끝나면 웹이 자동으로 새로고침됩니다.
- `updater`만 Docker 소켓을 가지며 외부 포트가 없습니다. `monitor`는 `UPDATER_TOKEN`으로만 요청할 수 있습니다.
- 되돌리기: `.env`의 `MONITOR_TAG`를 이전 버전으로 고치고 `docker compose up -d monitor`.
- `updater` 자체는 버튼 업데이트로 바뀌지 않습니다. 업데이터 코드가 바뀐 버전이면 서버에서 `docker compose up -d`를 한 번 실행하세요.

### 새 버전 올리기(개발 PC)

```powershell
# package.json의 version을 올린 뒤
docker build --platform linux/amd64 -t <레지스트리>/<저장소>:<버전> .
docker push <레지스트리>/<저장소>:<버전>
```

기존 기록을 옮길 때는 **서버를 정지한 상태에서** `.data` 폴더 전체(`monitor.sqlite`, `credentials.key`)를 함께 옮기세요. 실행 중인 SQLite 파일 하나만 복사하지 마세요. 이미지에는 기록이 들어있지 않습니다.

## 기록의 의미와 범위

- 장비 목록은 Devices API, 등록·삭제 시각과 행위자는 **Configuration audit logs**의 `NODE / CREATE·DELETE`에서 가져옵니다. 실패한 요청은 구분해서 표시합니다.
- ‘작업 경로’는 관리 콘솔·API·장비·Tailscale 서비스 등 `origin` 값입니다. 실제 작업 장소나 작업자 접속 IP는 이 API의 제공 항목에 없습니다. 공유 계정을 사용하면 로그에도 그 계정이 남습니다.
- 삭제된 장비의 IP는 이 프로그램이 앞서 수집한 적 있을 때만 표시합니다. 감사 로그가 지연되면 다음 수집 주기에 나타날 수 있습니다.
- 원본 감사 로그의 보관 기간은 90일입니다. 첫 수집은 최근 89일을 최대 7일씩 나누어 조회하고, 이후 마지막 성공 지점부터 10분을 겹쳐 가져와 중복을 제거합니다. 분할 조회가 모두 성공한 뒤 수집 시점을 저장하므로 일부 구간 실패를 전체 성공으로 처리하지 않습니다. 10분보다 늦게 도착한 로그는 놓칠 수 있으며 장기 중단으로 원본 보관 범위를 넘긴 구간은 복구할 수 없습니다. 받아둔 기록은 로컬 DB에 계속 보관하고 화면은 최근 500건을 표시합니다.
- 수집 실패 시 이전 장비 목록을 유지합니다. API 실패를 장비 삭제로 판단하지 않습니다. API 오류는 화면에 표시합니다. 브라우저와 서버가 모두 꺼진 상황을 이 프로그램 자체가 알릴 수는 없습니다.
- 폴링 간격 사이에 들어왔다 사라진 장비는 등록·삭제 이력에 남을 수 있지만, 당시 이름·태그를 Devices API에서 수집하지 못하면 컨벤션을 검사할 수 없습니다.
- 이 프로그램은 구성 변경 관제 도구입니다. 트래픽 분석이나 침입 탐지는 수행하지 않습니다.

## 검증

```powershell
npm.cmd test
npm.cmd run check
```

검증은 격리한 DB와 가상 API 응답을 사용합니다. 실제 인증정보를 넣기 전에는 현장 장비 수집과 Slack·Telegram 실수신을 확인한 상태가 아닙니다.

공식 자료: [Tailscale API](https://api.tailscale.com/api/v2), [OAuth](https://tailscale.com/docs/features/oauth-clients), [감사 로그](https://tailscale.com/docs/features/logging/audit-logging), [Slack Webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).
