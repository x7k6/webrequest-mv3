chrome.webRequest.onBeforeRequest.addListener(
  function () { return { cancel: true }; },
  { urls: ['http://127.0.0.1/webrequest-mv3/blocked'] }, ['blocking'],
);

chrome.webRequest.onBeforeRequest.addListener(
  () => ({ redirectUrl: 'http://127.0.0.1:8765/webrequest-mv3/headers' }),
  { urls: ['http://127.0.0.1/webrequest-mv3/old'] }, ['blocking'],
);

chrome.webRequest.onCompleted.addListener(({ statusCode, tabId }) => {
  if (tabId >= 0) chrome.browserAction.setBadgeText({ tabId, text: String(statusCode) });
}, { urls: ['http://127.0.0.1/webrequest-mv3/*'] });
