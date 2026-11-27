# webrequest-mv3

Convert a packaged Chrome extension from Manifest V2 to Manifest V3. The tool rewrites supported background scripts and the manifest into a **new, unpacked extension**. Use it to move blocking network listeners to declarative rules, move tab injection to `chrome.scripting`, and update legacy messaging calls.

[Documentation](https://x7k6.github.io/webrequest-mv3/) · [Migration guide](https://x7k6.github.io/webrequest-mv3/migration.html) · [Runtime API](https://x7k6.github.io/webrequest-mv3/reference.html)

## Convert and load an extension

With **Node.js 20+**, run this from the parent directory of the folder containing your MV2 `manifest.json`:

```sh
npx --yes --package=github:x7k6/webrequest-mv3 webrequest-mv3 ./my-extension ./my-extension-mv3
```

Open `chrome://extensions` in **Chrome 120+**, enable **Developer mode**, select **Load unpacked**, and choose `my-extension-mv3`. The output must be a new directory outside the input tree. If your extension uses a bundler, convert its packaged output rather than your entire project.

## What gets migrated

| MV2 input | MV3 output |
| --- | --- |
| Direct, top-level `webRequest.onBeforeRequest` listener that always cancels, redirects to a fixed HTTP(S) URL, or cancels on a supported HTTP method equality | Enabled static `declarativeNetRequest` rule. Use an inline callback, literal filter and literal flags. |
| Nonblocking webRequest listener; inline blocking `onAuthRequired` handler | Native observation; native `asyncBlocking` auth callback with `webRequestAuthProvider`. |
| `tabs.executeScript`, `tabs.insertCSS`, `tabs.removeCSS` | Corresponding `chrome.scripting` methods, with `target`, `files` or `css`, and the `scripting` permission. |
| `extension.getURL`, legacy `extension` messaging and connection aliases | `runtime.getURL`, `runtime.sendMessage`, `runtime.onMessage`, and corresponding runtime connection events. `tabs.sendRequest` becomes **`tabs.sendMessage`** so the message still goes to the tab. |
| `background.scripts`, `browser_action`, `options_page` | A classic service worker importing scripts in manifest order, `action`, and `options_ui` opening in its own tab. |
| Required and optional host patterns in permission lists | `host_permissions` and `optional_host_permissions`, respectively. |

### Example: tab injection

This MV2 background call inserts a stylesheet into every frame of the specified tab:

```js
chrome.tabs.insertCSS(tab.id, { file: 'reader.css', allFrames: true, cssOrigin: 'user' });
```

The generated call is:

```js
chrome.scripting.insertCSS({
  target: { tabId: tab.id, allFrames: true },
  files: ['reader.css'],
  origin: 'USER',
});
```

- Pass an **explicit tab ID** and an inline details object. A literal `frameId` becomes `target.frameIds: [id]`. Ordinary tab operations such as `chrome.tabs.query` stay on `chrome.tabs`.
- JavaScript `file` points to a packaged file. A fixed JavaScript `code` string is written to a packaged `.js` file at build time. Dynamic JavaScript strings require a manual port, usually `func` plus `args`. For CSS, `code` becomes `css` and can be an expression.
- Script callbacks still receive an array of per-frame **values** and can read `chrome.runtime.lastError`. The promise form also resolves to values. `scripting` by itself does not grant site access: injection still needs an existing host grant or `activeTab` from a user gesture.
- Implicit active-tab targeting, `matchAboutBlank: true`, and explicit scheduling other than `executeScript` at `document_idle` need review. The converter reports the file and line for unsupported direct calls.

## Use it in a build

```sh
npm install --save-dev github:x7k6/webrequest-mv3
```

```js
// build.mjs (Node.js)
import { migrateExtension } from 'webrequest-mv3/migrate';
const { outputDir, ruleCount } = await migrateExtension('./my-extension', './my-extension-mv3');
console.log(`${ruleCount} static network rules in ${outputDir}`);
```

The converter inspects the files listed in `background.scripts`. Review popup scripts, content scripts, imported files, and aliases separately. HTML background pages, DOM access, persistent globals, and arbitrary per-request blocking decisions need explicit migration.

For settings-driven rules or header edits, import `createRuleStore` and `compileRule` from `webrequest-mv3` in a bundled worker. `observe` and `provideAuth` cover native request events. Without a bundler, copy [`extension/lib/`](extension/lib/) and import from `./lib/index.js` in a module worker. See the [working worker](extension/worker.js) and [API reference](https://x7k6.github.io/webrequest-mv3/reference.html) for permissions, matching limits, and examples.

## Verify locally

```sh
npm ci
npm test
node bin/webrequest-mv3.js examples/legacy ../legacy-mv3
npm run demo
```

Load `../legacy-mv3` unpacked, then open <http://127.0.0.1:8765/webrequest-mv3/>. **Blocked navigation** should fail; **Redirect** should land on the headers page. To test header edits too, disable the converted fixture and load [`extension/`](extension/) instead.

**Documentation site:** serve [`docs/`](docs/) locally with `python3 -m http.server 8000 --bind 127.0.0.1 --directory docs`. To publish, choose **Settings → Pages → Deploy from a branch → main → /docs**. No build step is required.
