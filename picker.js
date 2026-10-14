/**
 * 영역 선택 모드: 마우스를 올린 요소를 강조 표시하고, 클릭하면 그 요소의 텍스트를 복사한다.
 * 자동 추출이 엉뚱한 영역을 고를 때 사용자가 직접 본문을 지정하는 보조 수단.
 *
 * background.js가 common.js와 함께 모든 프레임에 주입한다 (iframe 안 본문도 선택 가능).
 * 메시지 흐름:
 *   클릭 → { type: 'picked', text, title } 전송 → background가 클립보드 쓰기
 *   Esc  → { type: 'picker-cancel' } 전송
 *   background가 { type: 'picker-stop' }을 모든 프레임에 보내면 → 모드 종료
 */
(() => {
  // 이미 선택 모드가 켜진 프레임이면 중복 실행하지 않음
  if (globalThis.wccPickerActive) return;
  globalThis.wccPickerActive = true;

  // 마우스를 올린 요소 위에 겹쳐 그리는 강조 상자 (클릭을 가로채지 않도록 pointer-events: none)
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4F46E5;' +
    'background:rgba(79,70,229,.12);border-radius:4px;transition:all .05s;display:none';
  document.documentElement.append(box);

  // 안내 문구는 최상위 프레임에만 표시
  let banner = null;
  if (window === window.top) {
    banner = document.createElement('div');
    banner.textContent = '복사할 영역을 클릭하세요 · Esc 취소';
    banner.style.cssText = 'position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);' +
      'background:#111827;color:#fff;padding:10px 18px;border-radius:10px;pointer-events:none;' +
      'font:600 14px -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.documentElement.append(banner);
  }

  let target = null;

  /** 마우스가 올라간 요소로 강조 상자를 옮긴다. */
  function onMove(e) {
    target = e.target;
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  /**
   * 클릭한 요소의 텍스트를 background로 보낸다.
   * 캡처 단계에서 가로채 페이지의 링크 이동·클릭 이벤트가 실행되지 않게 막는다.
   */
  function onClick(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const text = wccCleanText(target?.innerText || '');
    if (!text) return; // 빈 영역 클릭은 무시하고 계속 선택 모드 유지
    chrome.runtime.sendMessage({ type: 'picked', text, title: wccFindTitle() });
  }

  /** mousedown/mouseup도 막아 페이지의 드래그·메뉴 동작이 끼어들지 않게 한다. */
  function block(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** Esc 키로 모든 프레임의 선택 모드를 취소한다. */
  function onKey(e) {
    if (e.key !== 'Escape') return;
    block(e);
    chrome.runtime.sendMessage({ type: 'picker-cancel' });
  }

  /** 이벤트 리스너와 강조 상자를 정리하고 모드를 끝낸다. */
  function stop() {
    removeEventListener('mouseover', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('mousedown', block, true);
    removeEventListener('mouseup', block, true);
    removeEventListener('keydown', onKey, true);
    chrome.runtime.onMessage.removeListener(onMessage);
    box.remove();
    banner?.remove();
    globalThis.wccPickerActive = false;
  }

  /** background에서 종료 신호를 받으면 정리한다. */
  function onMessage(msg) {
    if (msg?.type === 'picker-stop') stop();
  }

  // 페이지 핸들러보다 먼저 받도록 캡처 단계(true)에 등록
  addEventListener('mouseover', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('mousedown', block, true);
  addEventListener('mouseup', block, true);
  addEventListener('keydown', onKey, true);
  chrome.runtime.onMessage.addListener(onMessage);
})();
