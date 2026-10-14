/**
 * background.js가 보낸 { type: 'copy', text } 메시지를 받아 클립보드에 쓴다.
 * offscreen 문서는 포커스를 가질 수 없어 navigator.clipboard 대신
 * textarea 선택 + execCommand('copy') 방식을 쓴다 (Chrome 공식 예제와 같은 방식).
 * 응답: 복사 성공 여부(boolean)
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'copy') return;

  const textarea = document.querySelector('textarea');
  textarea.value = msg.text;
  textarea.select();
  sendResponse(document.execCommand('copy'));
});
