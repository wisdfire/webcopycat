# WebCopyCat

클릭 한 번으로 웹페이지의 **게시물 본문만** 일반 텍스트로 복사하는 Chrome 확장프로그램 (Manifest V3).

- 요구사항: [docs/requirements.md](docs/requirements.md)
- 로드맵: [docs/roadmap.md](docs/roadmap.md)

## 기술 스택

- JavaScript (ES2022), **빌드 도구·번들러·npm 런타임 의존성 없음**
- 본문 추출: `lib/Readability.js` (Mozilla Readability를 그대로 복사한 파일, **수정 금지**)
- Chrome API: `action`, `contextMenus`, `commands`, `scripting`, `offscreen`
- 권한: `activeTab`, `scripting`, `contextMenus`, `offscreen`, `clipboardWrite`, `storage`
  - offscreen에서 `execCommand('copy')`가 동작하려면 `clipboardWrite` 필수
  - `storage`: 제목 포함 설정(`includeTitle`) 저장

## 폴더 구조

```
manifest.json      확장프로그램 설정
background.js      서비스 워커: 실행 경로 → copyArticle(tab) / startPicker(tab), 클립보드·배지 처리
common.js          주입 공통 함수: wccSiteRule(사이트 규칙), wccFindTitle, wccHtmlToText, wccCleanText
content.js         자동 추출: 사이트 규칙 → Readability(숨김 요소 제거한 복제본) 순서로 { text, title, byRule } 반환
picker.js          영역 선택 모드: 마우스 강조 → 클릭 시 'picked' 메시지, Esc 시 'picker-cancel'
offscreen.html/js  클립보드 쓰기 전용 문서
lib/Readability.js 외부 라이브러리 (vendored)
icons/             icon.svg(원본) → 16/32/48/128px PNG
test/              fixture.html(복사 방지가 걸린 가상 게시판), e2e.mjs(Playwright 전체 흐름 테스트)
scripts/           render-assets.mjs(아이콘·스토어 이미지 렌더링)
store/             스토어 이미지 원본(assets.html), 생성된 PNG, 등록 문구(listing.md)
docs/              요구사항, 로드맵, 개인정보처리방침
```

배포 zip에는 `npm run zip`에 나열된 파일만 들어간다 (test/, store/, scripts/, docs/ 제외).

## 동작 흐름

**자동 복사** (툴바 클릭, 우클릭 "본문 복사", Alt+Shift+C)
1. `background.js`의 `copyArticle(tab)`
2. `chrome.scripting.executeScript({ allFrames: true })`로 `lib/Readability.js` → `common.js` → `content.js` 주입
3. 각 프레임이 `{ text, byRule }`을 반환 → `pickBest`가 사이트 규칙 매칭 결과를 우선, 그다음 가장 긴 결과 선택 (iframe 안 본문 대응)
4. offscreen 문서에서 클립보드에 쓰기
5. 아이콘 배지로 성공(`✓`)/실패(`!`) 표시. `includeTitle`이 켜져 있으면 `제목\n\n본문`

**영역 선택 복사** (우클릭 "영역 선택해서 복사", Alt+Shift+X)
1. `startPicker(tab)` → 모든 프레임에 `common.js`, `picker.js` 주입
2. 클릭한 프레임이 `{ type: 'picked', text, title }` 전송 → background가 모든 프레임에 `picker-stop` 보내고 복사

**제목 포함 설정**: 툴바 아이콘 우클릭 메뉴의 체크박스(`contexts: ['action']`) → `chrome.storage.sync`

## 핵심 규칙

- **원본 HTML을 다시 요청하지 말 것.** 본문이 JS로 렌더링되므로 항상 현재 탭의 DOM을 읽는다.
- **권한 추가 금지:** `<all_urls>` 같은 host_permissions를 요청하지 않는다. `activeTab`으로 충분하다. 권한을 추가해야 하면 먼저 사용자에게 묻는다.
- **복사 방지 우회 코드 불필요:** `innerText`로 읽고 확장프로그램 쪽에서 클립보드에 쓰면 페이지의 copy/selectstart 차단을 거치지 않는다.
- **Readability는 원본 DOM을 변형하므로** 반드시 `document.cloneNode(true)`에 대해 실행한다.
- 사이트 전용 규칙은 `common.js`의 `wccSiteRule()` 한 곳에서 `hostname → { body, title? }`로 관리한다. 선택자가 아무것도 찾지 못하면 Readability로 대체한다. 규칙 추가 시 `npm test -- <게시물 URL>`로 실제 결과를 확인한다.
- 주입 스크립트는 반복 주입되므로 최상위에 `const/let`을 두지 않는다 (common.js는 함수 선언만, 나머지는 IIFE).
- Readability 경로는 `isHidden()`으로 숨김 요소를 제거한 복제본을 쓴다 (페이지가 숨긴 텍스트가 클립보드에 섞이는 것 방지).
- 출력은 일반 텍스트만. 이미지는 제외한다. 연속된 빈 줄은 하나로 줄인다.
- 외부 네트워크 요청, 데이터 수집, 분석 도구 추가 금지 (`docs/privacy.md`에 "수집 없음"으로 고지함).

## 개발 및 테스트

- `npm install && npx playwright install chromium` (최초 1회)
- `npm test`: 확장프로그램을 실제 Chromium에 로드해 픽스처 페이지 복사 결과 검증. **코드를 고친 뒤 반드시 실행**
- `npm test -- <URL>`: 실제 사이트에서 복사 결과 출력 (사이트 규칙 추가·점검 시)
- `npm run assets`: 아이콘·스토어 이미지 재생성 / `npm run zip`: 업로드용 zip 생성
- 로드: `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → 이 폴더 선택
- 수정 후: 확장프로그램 카드의 새로고침 버튼을 누르고 대상 탭도 새로고침
- 서비스 워커 로그: 확장프로그램 카드의 "서비스 워커" 링크에서 DevTools 열기
- 아카라이브는 Cloudflare 봇 확인 때문에 자동 테스트 불가 (일반 브라우저에서는 정상)
- 수동 테스트 URL
  - https://forum.nexon.com/maplestoryidle-kr/board_view?board=6698&thread=3550026 (패치 내용만 복사되어야 함)
  - https://cafe.naver.com/omfgluckyme/477229 (복사 방지 상태에서도 본문이 복사되어야 함. **멤버 전용 글이라 비로그인 자동 테스트는 불가**, 로그인한 브라우저에서 수동 확인)

## 컨벤션

- 응답, 주석, 커밋 메시지, 문서: 한국어 / 변수명, 함수명: 영어
- 함수마다 목적·매개변수·반환값을 JSDoc 한국어 주석으로 작성
- 배포 시 `manifest.json`과 `package.json`의 `version`을 함께 올린다
- 스토어 스크린샷은 실제 동작과 다른 UI를 보여주지 않는다 (심사 정책)
