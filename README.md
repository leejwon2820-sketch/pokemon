# 포켓몬스터 레인 앤 마틱 멀티플레이 서버

현재 `pokemon-multiplayer-reset-legendary-fixed(1)-multiplayer-verified.html` 계열 클라이언트의 WebSocket 통신 규격에 맞춘 **월드 멀티 전용 중앙 서버**입니다.

## 포함 구조

```text
pokemon-multiplayer-server/
└─ server/
   ├─ server.js
   ├─ package.json
   ├─ test-server.mjs
   ├─ public/
   │  └─ index.html
   └─ data/
      ├─ server-config.json
      ├─ legendary-claims.json
      ├─ players.json
      └─ world.json
```

## 제공 기능

- 싱글/멀티가 분리된 현재 게임 HTML 제공
- WebSocket `/ws` 연결
- 플레이어 입장/퇴장
- 같은 월드의 플레이어 위치·맵·방향 동기화
- 채팅
- 전설 기믹 전역 선점
- **자신이 소유한 전설 기믹만 일괄 해제하는 `resetLegendaryClaims` 지원**
- 배틀 신청 / 수락 / 거절
- 수락 후 기존 PeerJS 1:1 배틀 연결 코드 전달
- 동일 player ID 재접속 처리
- 기존 연결의 늦은 close 이벤트가 새 세션을 지우지 않도록 세션 보호
- 메시지 최대 크기 제한
- 채팅/기믹/배틀 신청 rate limit
- 좌표·맵·방향 유효성 검사
- 같은 맵에서 비정상적인 순간이동 제한
- WebSocket ping/pong heartbeat
- HTTP `/health` 상태 확인
- 전설 기믹 영속 저장(원자적 파일 저장)

## 실행

Node.js 20 이상을 권장합니다.

```bash
cd server
npm install
npm test
npm start
```

접속:

```text
http://localhost:10000
```

멀티 WebSocket 주소:

```text
ws://localhost:10000/ws
```

현재 HTML은 기본적으로 **같은 웹사이트의 `/ws`**를 사용하므로, 이 서버로 게임 HTML까지 같이 서비스하면 별도의 URL 설정 없이 동작합니다.

## 데이터

`data/legendary-claims.json`에는 멀티 월드 전체의 전설 기믹 점유 상태가 저장됩니다.

`data/players.json`은 마지막으로 접속한 플레이어의 최소 메타데이터만 기록합니다. 게임 진행도, 팀, 가방 등의 개인 세이브는 서버에 저장하지 않고 각 플레이어의 브라우저 세이브를 유지합니다.

## 중요한 동작

전설 기믹을 A가 먼저 차지하면 서버가 해당 기믹을 전역으로 잠그고 모든 접속자에게 `claims`를 전파합니다.

A가 게임에서 멀티 저장 초기화를 실행하면 클라이언트는 `resetLegendaryClaims`를 보내고, 서버는 **A가 소유한 claim만 제거**한 뒤 `claimsReset`을 전파합니다. 이때 다른 플레이어들의 다른 전설 기믹 점유는 유지됩니다.

## 운영 시 권장

- 외부 공개 서버에서는 HTTPS/WSS 앞단을 사용하는 것이 좋습니다.
- 여러 Node 프로세스를 띄우는 경우에는 이 파일 기반 Map 구조 대신 Redis 같은 공유 저장소가 필요합니다.
- 서버를 재시작하면 `legendary-claims.json`에서 전설 기믹 상태를 다시 읽습니다.
