/**
 * 서비스 워커: 사용자 실행 경로를 기능별 함수로 연결한다.
 *   - 본문 자동 복사: 툴바 클릭 / 우클릭 "본문 복사" / Alt+Shift+C → copyArticle
 *   - 영역 선택 복사: 우클릭 "영역 선택해서 복사" / Alt+Shift+X → startPicker
 *   - 제목 포함 설정: 툴바 아이콘 우클릭 메뉴의 체크박스 (chrome.storage.sync에 저장)
 * Alt+Shift+C는 manifest의 "_execute_action" 명령이라 툴바 클릭(action.onClicked)과 같은 경로로 들어온다.
 */

const MENU_COPY = 'webcopycat-copy';
const MENU_PICK = 'webcopycat-pick';
const MENU_TITLE = 'webcopycat-title';
const PAGE_CONTEXTS = ['page', 'frame', 'selection', 'link', 'image'];

// 설치·업데이트 시 우클릭 메뉴 등록 (메뉴는 브라우저가 기억하므로 이때 한 번만 만든다)
chrome.runtime.onInstalled.addListener(async () => {
  const { includeTitle = false } = await chrome.storage.sync.get('includeTitle');
  chrome.contextMenus.create({ id: MENU_COPY, title: '본문 복사 (WebCopyCat)', contexts: PAGE_CONTEXTS });
  chrome.contextMenus.create({ id: MENU_PICK, title: '영역 선택해서 복사 (WebCopyCat)', contexts: PAGE_CONTEXTS });
  // 'action' 컨텍스트: 툴바 아이콘을 우클릭했을 때만 보이는 메뉴
  chrome.contextMenus.create({ id: MENU_TITLE, title: '복사할 때 제목 포함', type: 'checkbox', checked: includeTitle, contexts: ['action'] });
});

chrome.action.onClicked.addListener((tab) => copyArticle(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'pick-area' && tab) startPicker(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_TITLE) chrome.storage.sync.set({ includeTitle: info.checked });
  else if (info.menuItemId === MENU_COPY && tab) copyArticle(tab);
  else if (info.menuItemId === MENU_PICK && tab) startPicker(tab);
});

// picker.js에서 오는 메시지 처리 (영역 선택 완료 / 취소)
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return; // offscreen 문서 등 탭이 아닌 곳에서 온 메시지는 무시
  if (msg.type === 'picked') {
    stopPicker(tabId);
    copyAndNotify(tabId, msg);
  } else if (msg.type === 'picker-cancel') {
    stopPicker(tabId);
  }
});

/**
 * 현재 탭에서 본문을 자동 추출해 클립보드에 복사한다.
 * 흐름: 모든 프레임에 추출 스크립트 주입 → 가장 알맞은 결과 선택 → 클립보드 쓰기 → 배지 표시
 * @param {chrome.tabs.Tab} tab - 사용자가 실행한 탭
 */
async function copyArticle(tab) {
  try {
    // 모든 프레임에 주입 (네이버 카페처럼 본문이 iframe 안에 있는 경우 대응).
    // 권한이 없는 다른 출처의 프레임은 브라우저가 알아서 건너뛴다.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['lib/Readability.js', 'common.js', 'content.js'],
    });
    await copyAndNotify(tab.id, pickBest(results.map((r) => r.result)));
  } catch (err) {
    // chrome:// 페이지, 웹스토어 등 주입이 불가능한 곳도 여기로 온다
    fail(tab.id, err);
  }
}

/**
 * 영역 선택 모드를 시작한다. 실제 복사는 picker.js가 'picked' 메시지를 보낼 때 일어난다.
 * @param {chrome.tabs.Tab} tab - 사용자가 실행한 탭
 */
async function startPicker(tab) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['common.js', 'picker.js'],
    });
  } catch (err) {
    fail(tab.id, err);
  }
}

/**
 * 탭의 모든 프레임에 선택 모드 종료 신호를 보낸다.
 * @param {number} tabId - 대상 탭
 */
function stopPicker(tabId) {
  // 수신 프레임이 없을 때 나는 오류는 무시 (이미 닫힌 탭 등)
  chrome.tabs.sendMessage(tabId, { type: 'picker-stop' }).catch(() => {});
}

/**
 * 추출 결과를 (설정에 따라 제목을 붙여) 클립보드에 쓰고 배지로 결과를 알린다.
 * @param {number} tabId - 배지를 표시할 탭
 * @param {{text: string, title?: string}|null} result - 추출 결과
 */
async function copyAndNotify(tabId, result) {
  try {
    if (!result) throw new Error('본문을 찾지 못했습니다');
    const { includeTitle = false } = await chrome.storage.sync.get('includeTitle');
    await writeClipboard(includeTitle && result.title ? `${result.title}\n\n${result.text}` : result.text);
    showBadge(tabId, '✓', '#2e7d32');
  } catch (err) {
    fail(tabId, err);
  }
}

/**
 * 프레임별 추출 결과 중 하나를 고른다.
 * 사이트 규칙으로 찾은 결과를 최우선으로 하고, 같은 종류끼리는 더 긴 텍스트를 고른다.
 * (예: 네이버 카페는 바깥 프레임의 메뉴 텍스트보다 iframe 안 규칙 매칭 본문이 우선)
 * @param {Array<{text: string, title: string, byRule: boolean}|null>} candidates - 프레임별 결과
 * @returns {{text: string, title: string, byRule: boolean}|null} 선택된 결과, 없으면 null
 */
function pickBest(candidates) {
  const valid = candidates.filter(Boolean);
  const pool = valid.some((c) => c.byRule) ? valid.filter((c) => c.byRule) : valid;
  return pool.sort((a, b) => b.text.length - a.text.length)[0] || null;
}

/**
 * offscreen 문서를 통해 텍스트를 클립보드에 쓴다.
 * 서비스 워커에는 DOM이 없고, 페이지에서 쓰면 포커스 문제나 사이트의 copy 이벤트 차단에 걸릴 수 있어
 * 확장프로그램 전용 숨김 문서(offscreen.html)에서 처리한다.
 * @param {string} text - 복사할 텍스트
 */
async function writeClipboard(text) {
  // offscreen 문서는 확장프로그램당 하나만 만들 수 있으므로 없을 때만 생성
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: '추출한 본문 텍스트를 클립보드에 쓰기',
    });
  }
  const ok = await chrome.runtime.sendMessage({ type: 'copy', text });
  if (!ok) throw new Error('클립보드 쓰기 실패');
}

/**
 * 실패를 기록하고 실패 배지를 표시한다.
 * @param {number} tabId - 배지를 표시할 탭
 * @param {Error} err - 발생한 오류
 */
function fail(tabId, err) {
  console.warn('[WebCopyCat]', err);
  showBadge(tabId, '!', '#c62828');
}

/**
 * 툴바 아이콘에 배지를 잠깐 표시한 뒤 지운다.
 * @param {number} tabId - 배지를 표시할 탭
 * @param {string} text - 배지 문자 (✓ 또는 !)
 * @param {string} color - 배지 배경색
 */
function showBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 1500);
}
