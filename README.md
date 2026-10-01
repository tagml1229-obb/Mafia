# 🌙 웹 마피아 게임

HTML + Firebase로 만든 실시간 멀티플레이 마피아 게임입니다. 서버 비용 0원.

- 4~12명, 방 코드로 입장
- 직업: 마피아(인원에 따라 1~3명), 의사, 경찰, 시민
- 흐름: 대기실 → 밤(40초) → 낮 토론(90초) → 투표(30초) → 밤 … → 승리 판정
- 마피아끼리만 보이는 비밀 채팅, 경찰 조사 결과는 본인한테만 보임
- 밤에는 전체 채팅 금지, 죽은 사람은 말할 수 없음
- 새로고침해도 방에 다시 들어가짐

## 1. Firebase 프로젝트 만들기 (5분, 무료)

1. https://console.firebase.google.com 에서 **프로젝트 추가** (구글 애널리틱스는 꺼도 됨)
2. 왼쪽 메뉴 **빌드 → Authentication → 시작하기 → 로그인 방법 → 익명** → 사용 설정 → 저장
3. **빌드 → Realtime Database → 데이터베이스 만들기**
   - 위치: 싱가포르(asia-southeast1) 추천
   - **잠금 모드**로 시작
4. Realtime Database의 **규칙** 탭 → 내용을 전부 지우고 `database.rules.json` 내용을 붙여넣기 → **게시**
   - ⚠️ 이거 안 하면 게임이 안 돌아가거나, 남의 직업을 훔쳐볼 수 있게 됨
5. 톱니바퀴 **프로젝트 설정 → 일반 → 내 앱 → 웹(`</>`) 아이콘** → 앱 등록
6. 나오는 `firebaseConfig` 값을 `firebase-config.js`에 붙여넣기
   - `databaseURL`이 안 보이면 Realtime Database 화면 위쪽에 있는 주소(`https://...firebasedatabase.app`)를 복사

## 2. 내 컴퓨터에서 실행

`index.html`을 더블클릭하면 안 되고(모듈 로딩 막힘), 간단한 웹서버로 열어야 합니다.

```bash
# 이 폴더에서
npx serve .
# 또는
python -m http.server 8080
```

브라우저에서 `http://localhost:8080` 열기.
**혼자 테스트할 때는 탭을 4개 열면 각각 다른 플레이어**로 들어가집니다.

## 3. 친구들이랑 하기 (무료 배포)

### GitHub Pages
1. GitHub에 새 저장소를 만들고 이 폴더 파일들을 올리기
2. 저장소 **Settings → Pages → Branch: main / (root)** → Save
3. 1~2분 뒤 `https://내아이디.github.io/저장소이름/` 주소를 친구들한테 공유

### 또는 Firebase Hosting
```bash
npm i -g firebase-tools
firebase login
firebase use --add      # 내 프로젝트 선택
firebase deploy         # 사이트 + 보안 규칙 같이 배포됨
```

## 설정 바꾸기

`app.js` 맨 위에서 수정:

```js
const DURATION = { night: 40, day: 90, vote: 30 }; // 각 단계 시간(초)
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
```

방장 화면에 **⏭ 넘기기** 버튼이 있어서 다들 준비되면 시간 안 기다리고 넘길 수 있습니다.

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` / `style.css` | 화면 |
| `app.js` | 게임 로직 전부 |
| `firebase-config.js` | 내 Firebase 프로젝트 정보 |
| `database.rules.json` | 보안 규칙 (치트 방지) |

서버가 없기 때문에 **방장 브라우저가 진행자 역할**을 합니다. 직업 배정, 밤 결과 판정, 투표 집계, 단계 넘기기를 방장 브라우저가 처리해서 DB에 씁니다.
다른 플레이어는 보안 규칙 때문에 이런 걸 **못 합니다.**
- 남의 직업이나 밤 행동 보기
- 마피아가 아닌데 마피아 채팅 보기
- 죽었는데 말하거나 투표하기
- 가짜 시스템 메시지 쓰기, 게임 단계 조작

## 알아둘 점

- **방장은 마음먹으면 개발자도구로 직업을 볼 수 있습니다.** 진행 판정을 방장 브라우저가 해야 해서 생기는 한계라, 믿을 만한 사람이 방장을 하세요. 완벽하게 막으려면 Cloud Functions(유료 Blaze 요금제)나 별도 서버가 필요합니다.
- **방장이 창을 닫으면 게임이 멈춥니다.** 방장이 다시 들어오면(같은 탭 새로고침) 이어서 진행됩니다.
- 무료 요금제(Spark) 한도는 동시접속 100명, 저장 1GB, 월 10GB 다운로드로, 친구들끼리 하기엔 충분합니다.
- 오래된 방 데이터는 Firebase 콘솔의 Realtime Database 화면에서 `rooms`를 지우면 정리됩니다.

## 개발용: 로컬 에뮬레이터로 테스트

Firebase 프로젝트 없이 테스트하려면:

```bash
firebase emulators:start --only auth,database --project demo-mafia
```

그다음 `http://localhost:8080/?emu`로 접속하면 로컬 에뮬레이터에 연결됩니다.
