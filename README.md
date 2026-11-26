# webrequest-mv3

Port common `chrome.webRequest` listeners to Manifest V3. Describe blocking decisions as data and Chrome enforces them through `chrome.declarativeNetRequest` (DNR), even while the service worker is asleep. Keep ordinary event listeners for observation and use Chrome's asynchronous callback for authentication challenges.

This is a migration library, not a drop-in replacement for `addListener(fn, filter, ['blocking'])`. Ordinary MV3 extensions cannot execute arbitrary JavaScript to decide the fate of each in-flight request.

## Try it

1. In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select [`extension/`](extension/). The example requires Chrome 120+ and only requests host access to HTTP on `127.0.0.1`.
2. With Node.js 20+ installed, run `npm run demo` and open <http://127.0.0.1:8765/webrequest-mv3/>. No dependency installation or build is needed.
3. **Blocked navigation** should show `ERR_BLOCKED_BY_CLIENT`. **Redirect** should land on **Headers**, where the server echoes `X-Demo-Request: MV3`. In DevTools → Network the response should also have `X-Demo-Response: MV3`. Pin the extension to see the HTTP status badge set by `onCompleted`.

Run `npm test` for compiler, rule lifecycle, observation and auth tests.

## Port a listener

An MV2 `onBeforeRequest` listener might return `{ cancel: details.method === 'POST' }`. Instead of invoking that callback, declare which requests to cancel:

```js
import { createRuleStore } from './lib/index.js';

const rules = createRuleStore({ firstId: 100, lastId: 199 });
chrome.runtime.onInstalled.addListener(() => {
  rules.replace([{
    id: 100,
    event: 'onBeforeRequest',
    filter: { urls: ['*://*.example.org/beacon/*'], types: ['xmlhttprequest', 'ping'] },
    when: { requestMethods: ['post'] },
    response: { cancel: true },
  }]).catch(console.error);
});
```

To use this in your extension, copy [`extension/lib/`](extension/lib/) into the extension package and import it from a **module** service worker. For the permission model used by the example, declare `declarativeNetRequestWithHostAccess` and grant the necessary `host_permissions` for the target and, for subresources, the initiator. Add `webRequest` only if observing events or handling auth. See the [example manifest](extension/manifest.json).

| Intent | MV3 implementation |
| --- | --- |
| Cancel or redirect before a request | `event: 'onBeforeRequest'`; use `response: { cancel: true }` or `{ redirectUrl: 'https://…' }`. Redirects accept absolute HTTP(S) URLs. |
| Edit outgoing headers | `event: 'onBeforeSendHeaders'`; use `response.requestHeaders`, an array of explicit `{ header, operation, value? }` edits. |
| Edit incoming headers | `event: 'onHeadersReceived'`; use `response.responseHeaders` with the same edit format. |
| Restrict by method, originating site, or first/third party | Add `when.requestMethods` (lowercase DNR values), `when.initiatorDomains` (bare domains including their subdomains), or `when.domainType` (`firstParty` / `thirdParty`). These conditions are ANDed with the filter. |
| Restrict a rule to one tab | Set `scope: 'session'` on the store and `filter.tabId` on the rule. Use a nonnegative Chrome tab ID. |
| Observe timing, status, errors, redirects, headers or request body | Use `observe()` or native nonblocking `chrome.webRequest`. Chrome supplies the real event details. Registration is synchronous and returns an unsubscribe function. |
| Respond to an HTTP authentication challenge | Use `provideAuth()` and add `webRequestAuthProvider` alongside `webRequest` and appropriate host permissions. |

Header operations are `set`, `append` and `remove` (no value). They modify named fields; an MV2 array representing the *entire* header list is not an edit list. Chrome restricts which request headers may be appended. See [worker.js](extension/worker.js) for working request and response examples.

### Rule ownership and lifecycle

- `store.replace(specs)` replaces **the whole reserved ID range** in one atomic Chrome update. Reuse an ID to change a rule; omit it to remove it; `await store.replace([])` clears the range. IDs outside the range are left alone. Give each range one writer and reuse one store instance per worker so overlapping calls are serialized.
- The default `dynamic` ruleset survives worker and browser restarts and extension updates. `session` rules survive worker suspension but are cleared on browser shutdown and extension update. Reinstall session rules when needed. The store reads Chrome's rules before writing; it doesn't rely on IDs remembered in worker globals.
- `compileRule(spec, scope?)` returns a native DNR rule without installing it. `id` is required; `priority` defaults to `1`. Conflicts follow [Chrome's DNR evaluation order](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#rule-evaluation), not listener registration order.

### URL matching and limits

`filter.urls` is a nonempty list of alternatives. Supported: exact ASCII hosts (use Punycode for IDNs), `*`, `*.example.org` (also matches the apex), `*` in the path/query, `file:///…`, and `http`, `https`, `ws`, `wss`, `ftp` schemes. `*://` means HTTP or HTTPS. Here `<all_urls>` means the listed network/file schemes, subject to Chrome's actual interception and file-access permissions. Ports on requests are matched; explicit ports and literal IPv6 hosts in **patterns** are not supported. `filter.types` defaults to all supported resource types, including `main_frame`.

Each description uses one anchored RE2 filter, even for multiple URL alternatives. Paths and queries match Chrome's serialized URL case-sensitively, **not** a percent-decoded path; percent-encoding equivalence can differ from a native `webRequest` match pattern. Use `store.replace()`'s rejection to report unsupported regexes and quota errors. For large lists or advanced redirects, prefer native DNR static rules or simpler `urlFilter`/domain conditions.

There is no DNR `windowId`, per-request callback, or body-dependent blocking decision. Unsupported filter fields and stages throw rather than silently widening the rule. Observation cannot modify a request already underway.

### Event listeners and authentication

Register listeners at the **top level of the service worker** so Chrome can wake it for events. `observe` forwards native filters and event-specific options; it rejects `blocking` and `asyncBlocking`.

```js
import { observe, provideAuth } from './lib/index.js';

observe('onErrorOccurred', ({ error }) => console.debug(error), {
  urls: ['https://example.org/*'],
});

// lookupForChallenge is supplied by your application. It should bound retries
// and return { authCredentials: { username, password } }, { cancel: true },
// or undefined to let Chrome handle the challenge normally.
provideAuth({ urls: ['https://intranet.example.org/*'] }, async details => {
  if (details.isProxy || details.challenger.host !== 'intranet.example.org' ||
      details.challenger.port !== 443 || details.realm !== 'intranet') return;
  return lookupForChallenge(details);
});
```

`provideAuth` bridges sync/Promise results to `onAuthRequired`'s `asyncBlocking` callback. A thrown error, rejection, or malformed result cancels that challenge. Both helpers return a function that removes the registered listener.

References: [Migrating blocking listeners](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests) · [declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) · [webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest).
