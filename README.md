# webrequest-mv3

Convert a packaged Chrome extension from Manifest V2 to Manifest V3. The tool follows manifest entries for background scripts, extension pages and content scripts, and writes a **new, unpacked extension**. Use it to move blocking network listeners to declarative rules, move tab injection to `chrome.scripting`, and update legacy messaging calls.

[Documentation](https://x7k6.github.io/webrequest-mv3/) · [Migration guide](https://x7k6.github.io/webrequest-mv3/migration.html) · [Runtime API](https://x7k6.github.io/webrequest-mv3/reference.html)

## Convert and load an extension

With **Node.js 20+**, run this from the parent directory of the folder containing your MV2 `manifest.json`:

```sh
npx --yes github:x7k6/webrequest-mv3 ./my-extension
```

This creates `my-extension-mv3` beside `my-extension`. Open `chrome://extensions` in **Chrome 120+**, enable **Developer mode**, select **Load unpacked**, and choose that new folder. If your extension uses a bundler, pass its packaged output folder (or the `manifest.json` inside it).

| To… | Run |
| --- | --- |
| Check whether conversion succeeds before keeping the result | `npx --yes github:x7k6/webrequest-mv3 ./my-extension --check` |
| Choose a different output folder | `npx --yes github:x7k6/webrequest-mv3 ./my-extension -o ./release-mv3` |
| See usage and examples | `npx --yes github:x7k6/webrequest-mv3 --help` |

`--check` runs the converter on a temporary copy and cleans it up; test runtime behavior in Chrome after conversion. The original `webrequest-mv3 <input> <output>` syntax still works. The destination must be a new folder outside the input, with an existing parent.

## What gets migrated

| MV2 input | MV3 output |
| --- | --- |
| Direct, top-level `webRequest.onBeforeRequest` listener that always cancels, redirects to a fixed HTTP(S) URL, or cancels on a supported HTTP method equality | Enabled static `declarativeNetRequest` rule. Use an inline callback, literal filter and literal flags. |
| Nonblocking webRequest listener; inline blocking `onAuthRequired` handler | Native observation; native `asyncBlocking` auth callback with `webRequestAuthProvider`. |
| `tabs.executeScript`, `tabs.insertCSS`, `tabs.removeCSS` | Corresponding `chrome.scripting` methods, with `target`, `files` or `css`, and the `scripting` permission. |
| `extension.getURL`, legacy `extension` messaging and connection aliases | `runtime.getURL`, `runtime.sendMessage`, `runtime.onMessage`, and corresponding runtime connection events. `tabs.sendRequest` becomes **`tabs.sendMessage`** so the message still goes to the tab. |
| `background.scripts` or a script-only [`background.page`](#html-background-pages) | A classic service worker importing packaged scripts in their original order. |
| `browser_action`, `options_page` | `action`, and `options_ui` opening in its own tab. |
| Required and optional host patterns in permission lists | `host_permissions` and `optional_host_permissions`, respectively. |

### HTML background pages

If your MV2 manifest uses `"background": { "page": "pages/background.html" }`, the same CLI can convert a page like this:

```html
<!doctype html>
<script src="../shared.js"></script>
<script src="listeners.js"></script>
```

The worker is generated beside the HTML file. It loads `shared.js` first, then `pages/listeners.js`; both scripts go through the normal API migrations. This subset accepts classic local `.js` scripts, comments, and simple document metadata. Inline scripts, `async`/`defer`, modules, and markup such as iframes require manual migration. Common page-only globals such as `document` and `localStorage` are flagged with a source location.

### Popups, options pages and content scripts

The converter follows local `<script src>` tags in `browser_action.default_popup`, `options_page`, `options_ui.page`, `devtools_page`, and `chrome_url_overrides`. Both classic scripts and external `type="module"` entry files are supported. The HTML stays in place, including DOM controls, script order, and loading attributes. Popup-only extensions do not need a background worker.

Files listed in `content_scripts[].js` get compatible messaging and URL rewrites; their `matches`, CSS and injection timing stay in the manifest. For an example, convert [`examples/popup/`](examples/popup/) and open its **Read page title** popup on the loopback demo. It sends a message to a content script and displays its reply.

Move inline JavaScript and inline HTML event handlers into a packaged script first. Review module dependencies, dynamically loaded scripts, nested frames and popups selected at runtime separately. Calls to `getBackgroundPage()` and blocking listeners owned by UI or shared scripts require a manual port so they retain the intended lifetime.

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

The converter processes each discovered entry file once, including files shared by multiple pages. For state shared between a popup and its service worker, use runtime messaging or extension storage; worker globals do not persist across suspension.

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
