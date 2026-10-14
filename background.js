/**
 * 서비스 워커: 세 가지 실행 경로(툴바 클릭, 우클릭 메뉴, 단축키)를 copyArticle 하나로 연결한다.
 * 단축키는 manifest의 "_execute_action" 명령이라 툴바 클릭(action.onClicked)과 같은 경로로 들어온다.
 */

const MENU_ID = 'webcopycat-copy';

// 설치·업데이트 시 우클릭 메뉴 등록 (메뉴는 브라우저가 기억하므로 이때 한 번만 만든다)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '본문 복사 (WebCopyCat)',
    contexts: ['page', 'frame', 'selection', 'link', 'image'],
  });
});

chrome.action.onClicked.addListener((tab) => copyArticle(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab) copyArticle(tab);
});

/**
 * 현재 탭에서 본문을 추출해 클립보드에 복사하고, 결과를 아이콘 배지로 알린다.
 * 흐름: 모든 프레임에 추출 스크립트 주입 → 가장 알맞은 결과 선택 → 클립보드 쓰기 → 배지 표시
 * @param {chrome.tabs.Tab} tab - 사용자가 실행한 탭
 */
async function copyArticle(tab) {
  try {
    // 1) 모든 프레임에 주입 (네이버 카페처럼 본문이 iframe 안에 있는 경우 대응).
    //    권한이 없는 다른 출처의 프레임은 브라우저가 알아서 건너뛴다.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['lib/Readability.js', 'content.js'],
    });

    // 2) 각 프레임의 결과 중 하나를 고른다
    const best = pickBest(results.map((r) => r.result));
    if (!best) throw new Error('본문을 찾지 못했습니다');

    // 3) 클립보드에 쓰기
    await writeClipboard(best.text);
    showBadge(tab.id, '✓', '#2e7d32');
  } catch (err) {
    // chrome:// 페이지, 웹스토어 등 주입이 불가능한 곳도 여기로 온다
    console.warn('[WebCopyCat]', err);
    showBadge(tab.id, '!', '#c62828');
  }
}

/**
 * 프레임별 추출 결과 중 하나를 고른다.
 * 사이트 규칙으로 찾은 결과를 최우선으로 하고, 같은 종류끼리는 더 긴 텍스트를 고른다.
 * (예: 네이버 카페는 바깥 프레임의 메뉴 텍스트보다 iframe 안 규칙 매칭 본문이 우선)
 * @param {Array<{text: string, byRule: boolean}|null>} candidates - 프레임별 결과
 * @returns {{text: string, byRule: boolean}|null} 선택된 결과, 없으면 null
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
