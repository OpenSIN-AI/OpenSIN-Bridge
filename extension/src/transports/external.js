/** External runtime messaging transport — stub. */
export function attach({ router }) {
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    try {
      const result = router(msg);
      sendResponse(result);
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  });
}
