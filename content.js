/**
 * 페이지(각 프레임)에 주입되어 게시물 본문 텍스트를 자동 추출하는 스크립트.
 *
 * background.js가 lib/Readability.js, common.js와 함께 주입하며,
 * 이 파일 마지막 표현식의 값({ text, title, byRule } 또는 null)이 executeScript의 결과로 돌아간다.
 *
 * 같은 탭에서 여러 번 주입될 수 있으므로 전역 변수를 만들지 않도록 전체를 IIFE로 감싼다.
 * (최상위 const를 쓰면 두 번째 주입 때 "already declared" 오류 발생)
 */
(() => {
  /**
   * 요소가 사용자 눈에 보이지 않는지 판단한다.
   * - display:none, visibility:hidden, opacity:0 (조상이 숨겨진 경우 포함)
   * - 화면 왼쪽·위쪽 바깥으로 밀어낸 요소 (예: left:-9999px)
   * - 1px 이하 크기로 잘라 낸 요소 (예: 스크린리더 전용 .sr-only)
   * @param {Element} el - 실제 문서의 요소
   * @returns {boolean} 숨겨져 있으면 true
   */
  function isHidden(el) {
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return true;
    const rect = el.getBoundingClientRect();
    const offscreen = rect.right + scrollX <= 0 || rect.bottom + scrollY <= 0;
    const clipped = rect.width <= 1 && rect.height <= 1 && el.textContent.trim() !== '';
    // ponytail: 글자색=배경색, 아주 작은 글씨 같은 숨김은 못 잡음
    return offscreen || clipped;
  }

  /**
   * 화면에 보이지 않는 요소를 제거한 문서 복제본을 만든다.
   * 복제본에는 스타일 계산 정보가 없어서, 실제 문서에서 숨김 여부를 판단한 뒤
   * 같은 순서(querySelectorAll 순서는 원본과 복제본이 동일)의 복제본 요소를 지운다.
   * 목적: 페이지가 CSS로 숨겨 둔 텍스트가 사용자 모르게 클립보드에 섞이는 것을 방지
   * @returns {Document} 보이는 요소만 남은 복제 문서
   */
  function cloneVisibleDocument() {
    const clone = document.cloneNode(true);
    const liveElements = document.querySelectorAll('body *');
    const clonedElements = clone.querySelectorAll('body *');
    const hidden = [];
    liveElements.forEach((el, i) => {
      if (isHidden(el)) hidden.push(clonedElements[i]);
    });
    hidden.forEach((el) => el.remove());
    return clone;
  }

  /**
   * Readability로 본문을 자동 추출한다.
   * Readability는 넘겨받은 문서를 변형하므로 반드시 복제본에 실행한다.
   * @returns {{text: string, title: string}|null} 본문 텍스트와 제목, 추출 실패 시 null
   */
  function extractWithReadability() {
    // 본문이 거의 없는 프레임(광고, 빈 iframe)은 건너뜀
    if (!document.body || document.body.innerText.trim().length < 50) return null;

    // charThreshold: 본문 판정 최소 글자 수 (기본 500).
    // 한글은 글자당 정보량이 많아 짧은 게시물이 기준 미달 → 댓글까지 포함되는 문제가 있어 낮춘다.
    const article = new Readability(cloneVisibleDocument(), { charThreshold: 100 }).parse();
    if (!article || !article.content) return null;

    // Readability 결과 HTML을 DOMParser로 파싱 (스크립트가 실행되지 않는 안전한 방식)
    const doc = new DOMParser().parseFromString(article.content, 'text/html');
    // Readability 제목은 "글 제목 - 사이트명"에서 사이트명을 떼어 내 주므로 우선 사용
    return { text: wccHtmlToText(doc.body), title: article.title || '' };
  }

  // ---- 실행부: 사이트 규칙 → Readability 순서로 시도 ----
  const rule = wccSiteRule();
  const ruleElement = rule && document.querySelector(rule.body);
  if (ruleElement) {
    // 화면에 렌더링된 요소는 innerText가 줄바꿈·숨김 요소를 가장 정확히 반영한다.
    // 복사 방지(user-select: none, copy 이벤트 차단)는 innerText 읽기에 영향을 주지 않는다.
    const text = wccCleanText(ruleElement.innerText);
    if (text) return { text, title: wccFindTitle(), byRule: true };
  }

  const article = extractWithReadability();
  const text = wccCleanText(article?.text || '');
  if (!text) return null;
  return { text, title: wccCleanText(article.title) || wccFindTitle(), byRule: false };
})();
