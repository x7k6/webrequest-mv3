import { createRuleStore, observe } from './lib/index.js';

const base = 'http://127.0.0.1/webrequest-mv3/';
const filter = path => ({ urls: [base + path] });
const store = createRuleStore({ firstId: 1, lastId: 99 });

chrome.runtime.onInstalled.addListener(() => {
  store.replace([
    { id: 1, event: 'onBeforeRequest', filter: filter('blocked'), response: { cancel: true } },
    { id: 2, event: 'onBeforeRequest', filter: filter('old'),
      response: { redirectUrl: 'http://127.0.0.1:8765/webrequest-mv3/headers' } },
    { id: 3, event: 'onBeforeSendHeaders', filter: filter('headers'), when: { requestMethods: ['get'] },
      response: { requestHeaders: [{ header: 'X-Demo-Request', operation: 'set', value: 'MV3' }] } },
    { id: 4, event: 'onHeadersReceived', filter: filter('headers'),
      response: { responseHeaders: [{ header: 'X-Demo-Response', operation: 'set', value: 'MV3' }] } },
  ]).catch(error => console.error('Could not install demo rules:', error));
});

observe('onCompleted', ({ tabId, statusCode }) => {
  if (tabId >= 0) {
    // A tab may close between onCompleted and the badge update.
    chrome.action.setBadgeText({ tabId, text: String(statusCode) }).catch(() => {});
  }
}, filter('*'));
