import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { migrateExtension } from 'webrequest-mv3/migrate';

async function fixture(t, script, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wr-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, 'src'), out = join(dir, 'dist');
  await mkdir(src);
  await writeFile(join(src, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'fixture', version: '1',
    background: { scripts: ['./bg.js'] }, permissions: ['webRequest', 'webRequestBlocking', 'https://example.org/*'], ...extra }));
  await writeFile(join(src, 'bg.js'), script);
  return { src, out, build: () => migrateExtension(src, out),
    read: path => readFile(join(out, path), 'utf8') };
}

const filter = `{ urls: ['https://example.org/*'] }`;
const registration = callback => `chrome.webRequest.onBeforeRequest.addListener(${callback}, ${filter}, ['blocking']);`;

test('convert a packaged extension, keeping the input and original host access boundaries', async t => {
  const observe = `chrome.webRequest.onCompleted.addListener(console.log, ${filter});`;
  const source = registration(`info => ({ cancel: info.method === 'POST' })`) + '\n' + observe;
  const f = await fixture(t, source, { optional_permissions: ['tabs', 'https://optional.example/*'],
    background: { scripts: ['./bg.js', 'second.js'] } });
  await writeFile(join(f.src, 'second.js'), registration(`function () { return {redirectUrl: 'https://example.org/new'}; }`));
  assert.equal((await f.build()).ruleCount, 2);
  const m = JSON.parse(await f.read('manifest.json'));
  assert.deepEqual(m.permissions, ['webRequest', 'declarativeNetRequestWithHostAccess']);
  assert.deepEqual(m.host_permissions, ['https://example.org/*']);
  assert.deepEqual(m.optional_host_permissions, ['https://optional.example/*']);
  assert.deepEqual(m.optional_permissions, ['tabs']);
  assert.match(await f.read(m.background.service_worker), /importScripts\("\.\/bg.js", "\.\/second.js"\)/);
  const rules = JSON.parse(await f.read(m.declarative_net_request.rule_resources[0].path));
  assert.deepEqual(rules.map(r => r.action.type), ['block', 'redirect']);
  assert.deepEqual(rules[0].condition.requestMethods, ['post']);
  assert.equal(new Set(rules.map(r => r.id)).size, 2);
  assert.ok((await f.read('bg.js')).includes(observe));
  assert.equal(await readFile(join(f.src, 'bg.js'), 'utf8'), source);
  await assert.rejects(f.build(), { code: 'EEXIST' });
});

test('auth adapter preserves closure, delivers response through Chrome callback, and handles failure', async t => {
  const f = await fixture(t, `const realm = 'demo';\nchrome.webRequest.onAuthRequired.addListener(function(details) {
    if (details.realm === realm) return { cancel: true };
    if (details.realm === 'error') throw new Error();
  }, ${filter}, ['blocking', 'responseHeaders']);`);
  await f.build();
  const m = JSON.parse(await f.read('manifest.json'));
  assert.ok(m.permissions.includes('webRequestAuthProvider'));
  assert.equal(m.declarative_net_request, undefined);
  let listener;
  const event = { addListener(fn, _filter, opts) { listener = fn; assert.deepEqual([...opts], ['asyncBlocking', 'responseHeaders']); } };
  runInNewContext(await f.read('bg.js'), { chrome: { webRequest: { onAuthRequired: event } } });
  for (const [realm, expected] of [['demo', { cancel: true }], ['other', {}], ['error', { cancel: true }]]) {
    const response = await new Promise(resolve => assert.equal(listener({ realm }, resolve), undefined));
    assert.deepEqual({ ...response }, expected);
  }
});

test('do not turn conditional, side-effectful or aliased listeners into always-on rules', async t => {
  for (const source of [
    `if (enabled) ${registration('() => ({cancel:true})')}`,
    registration('() => { recordRequest(); return {cancel:true}; }'),
    registration('details => ({ cancel: shouldBlock(details) })'),
    `const wr = chrome.webRequest; wr.onBeforeRequest.addListener(fn, filter, flags);`,
  ]) {
    const f = await fixture(t, '\n' + source);
    await assert.rejects(f.build(), /bg\.js:2:\d+:/);
    await assert.rejects(stat(f.out), { code: 'ENOENT' });
  }
});

test('protect source tree and reject out-of-package script paths', async t => {
  const f = await fixture(t, '', { background: { scripts: ['../outside.js'] } });
  await assert.rejects(migrateExtension(f.src, join(f.src, 'dist')), /outside the input/);
  await assert.rejects(f.build(), /package-relative paths/);
  await assert.rejects(stat(f.out), { code: 'ENOENT' });
});

test('port a script-only HTML page: preserve source order, relative URLs, and existing conversions', async t => {
  const f = await fixture(t, `const first = chrome.extension.getURL('settings.html');`, {
    background: { page: 'pages/background.html', persistent: false },
  });
  await mkdir(join(f.src, 'pages'));
  await writeFile(join(f.src, 'pages/background.html'), `<!DOCTYPE html><html lang="en"><head>
    <meta charset="utf-8"><title>Background</title><!-- <script src="unused.js"></script> -->
    <SCRIPT SRC='../bg.js'></SCRIPT></head><body>
    <script type="text/javascript" src="./events.js"></script></body></html>`);
  await writeFile(join(f.src, 'pages/events.js'), `globalThis.url = first;\n` + registration('() => ({cancel: true})'));
  assert.equal((await f.build()).ruleCount, 1);
  const m = JSON.parse(await f.read('manifest.json'));
  const worker = m.background.service_worker;
  assert.equal(worker, 'pages/webrequest-mv3-worker.js');
  let imports;
  runInNewContext(await f.read(worker), { importScripts(...urls) { imports = urls; } });
  const base = new URL(worker, 'https://example.invalid/');
  const context = { chrome: { runtime: { getURL: path => 'fixture:/' + path } } };
  for (const url of imports) runInNewContext(await f.read(new URL(url, base).pathname.slice(1)), context);
  assert.equal(context.url, 'fixture:/settings.html');
  assert.equal(m.permissions.includes('offscreen'), false);
});

test('reject unsupported HTML and external sources with a page location and no partial output', async t => {
  for (const html of [
    '<script>start()</script>', '<script async src="bg.js"></script>', '<script type="module" src="bg.js"></script>',
    '<script src="https://cdn.example/bg.js"></script>', '<script src="../outside.js"></script>',
    '<base href="/elsewhere/">', '<body onload="start()">', '<iframe src="frame.html"></iframe>',
  ]) {
    const f = await fixture(t, '', { background: { page: 'background.html' } });
    await writeFile(join(f.src, 'background.html'), `<!doctype html>\n${html}`);
    await assert.rejects(f.build(), /background\.html:2:\d+:/);
    await assert.rejects(stat(f.out), { code: 'ENOENT' });
  }
});

test('diagnose page-dependent JavaScript and ambiguous manifest input', async t => {
  const f = await fixture(t, `\nconst root = document.body;`, { background: { page: 'background.html' } });
  await writeFile(join(f.src, 'background.html'), '<script src="/bg.js"></script>');
  await assert.rejects(f.build(), /bg\.js:2:\d+: document is unavailable/);
  const both = await fixture(t, '', { background: { page: 'background.html', scripts: ['bg.js'] } });
  await assert.rejects(both.build(), /choose background.page or background.scripts/);
});

test('inject packaged code into the requested frame and preserve callback results and lastError', async t => {
  const f = await fixture(t, `chrome.tabs.query({ active: true }, ([tab]) => {
    chrome.tabs.executeScript(tab.id, {code: 'document.title', frameId: 3}, values => {
      chrome.extension.sendRequest({ values, error: chrome.extension.lastError?.message });
    });
  });`, { permissions: ['activeTab'], options_page: 'options.html' });
  await writeFile(join(f.src, 'options.html'), '<title>Options</title>');
  await f.build();
  const m = JSON.parse(await f.read('manifest.json'));
  assert.deepEqual(m.permissions, ['activeTab', 'scripting']);
  assert.equal(m.host_permissions, undefined);
  assert.deepEqual(m.options_ui, { page: 'options.html', open_in_tab: true });
  let injection, reply, message;
  const runtime = { sendMessage(m) { message = m; } };
  runInNewContext(await f.read('bg.js'), { chrome: { runtime,
    tabs: { query(_filter, cb) { cb([{ id: 7 }]); } },
    scripting: { executeScript(spec, cb) { injection = spec; reply = cb; } },
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(injection.target)), { tabId: 7, frameIds: [3] });
  assert.equal(await f.read(injection.files[0]), 'document.title');
  reply([{ result: 'Page title', frameId: 3 }]);
  assert.deepEqual([...message.values], ['Page title']);
  runtime.lastError = { message: 'Access denied' };
  reply();
  delete runtime.lastError;
  assert.equal(message.error, 'Access denied');
  assert.equal(message.values, undefined);
});

test('migrate file injection and matching CSS insert/remove operations in order', async t => {
  const f = await fixture(t, `(async () => {
    const css = 'body { color: navy }';
    await chrome.tabs.insertCSS(0, {code: css, allFrames: true, cssOrigin: 'user'});
    const result = await chrome.tabs.executeScript(0, {file: 'title.js'});
    await chrome.tabs.removeCSS(0, {code: css, allFrames: true, cssOrigin: 'user'});
    return result;
  })()`);
  await f.build();
  const calls = [];
  const result = await runInNewContext(await f.read('bg.js'), { chrome: { scripting: {
    insertCSS: spec => calls.push(spec), removeCSS: spec => calls.push(spec),
    executeScript: async spec => { calls.push(spec); return [{ result: 'Main' }, { result: 'Sub' }]; },
  } } });
  assert.deepEqual([...result], ['Main', 'Sub']);
  const [insert, execute, remove] = JSON.parse(JSON.stringify(calls));
  assert.deepEqual(insert, { target: { tabId: 0, allFrames: true }, css: 'body { color: navy }', origin: 'USER' });
  assert.deepEqual(remove, insert);
  assert.deepEqual(execute, { target: { tabId: 0 }, files: ['title.js'] });
});

test('keep tab messaging separate from runtime messaging and do not grant scripting unnecessarily', async t => {
  const f = await fixture(t, `chrome.extension.onRequest.addListener((_msg, sender) => {
    chrome.tabs.sendRequest(sender.tab.id, chrome.extension.getURL('help.html'));
  });`);
  await f.build();
  assert.ok(!JSON.parse(await f.read('manifest.json')).permissions.includes('scripting'));
  let reply;
  runInNewContext(await f.read('bg.js'), { chrome: {
    runtime: { onMessage: { addListener(cb) { cb(null, { tab: { id: 1 } }); } }, getURL: path => `extension:/${path}` },
    tabs: { sendMessage(...args) { reply = args; } },
  } });
  assert.deepEqual(reply, [1, 'extension:/help.html']);
});

test('decline ambiguous injection instead of widening the target or evaluating code', async t => {
  for (const args of ["{file: 'a.js'}", '1, options', '1, {code: buildScript()}',
    "1, {file: 'a.js', runAt: 'document_start'}", "1, {file: 'a.js', matchAboutBlank: true}",
    "1, {file: 'a.js', frameId: 1, allFrames: true}"]) {
    const f = await fixture(t, `\nchrome.tabs.executeScript(${args});`);
    await assert.rejects(f.build(), /bg\.js:2:1:/);
    await assert.rejects(stat(f.out), { code: 'ENOENT' });
  }
});

test('wire a popup to its content script through the migrated messaging APIs without a worker', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wr-popup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'dist');
  await migrateExtension('examples/popup', out);
  const read = path => readFile(join(out, path), 'utf8');
  const m = JSON.parse(await read('manifest.json'));
  assert.equal(m.action.default_popup, 'ui/popup.html');
  assert.equal(m.background, undefined);
  assert.deepEqual(m.permissions, []);
  assert.deepEqual(m.content_scripts[0].matches, ['http://127.0.0.1/*']);
  let receive, click;
  const output = {};
  runInNewContext(await read(m.content_scripts[0].js[0]), { document: { title: 'Local demo' },
    chrome: { runtime: { onMessage: { addListener(fn) { receive = fn; } } } } });
  runInNewContext(await read('ui/popup.js'), {
    document: { querySelector(id) { return id === '#result' ? output : { addEventListener(_event, fn) { click = fn; } }; } },
    chrome: { runtime: {}, tabs: { query(_q, cb) { cb([{ id: 73 }]); }, sendMessage(id, msg, cb) {
      assert.equal(id, 73); receive(msg, {}, cb);
    } } },
  });
  click();
  assert.equal(output.textContent, 'Local demo');
});

test('shared module entry in popup and options page: keep markup and convert injection once', async t => {
  const f = await fixture(t, '', { background: undefined, permissions: ['activeTab'],
    options_ui: { page: 'options.html' }, browser_action: { default_popup: 'ui/popup.html' } });
  const markup = '<!doctype html><main>Preferences</main><script type="module" src="../shared.mjs"></script>';
  await mkdir(join(f.src, 'ui'));
  await writeFile(join(f.src, 'ui/popup.html'), markup);
  await writeFile(join(f.src, 'options.html'), '<script type="module" src="/shared.mjs"></script>');
  await writeFile(join(f.src, 'shared.mjs'), `export const apply = tab => chrome.tabs.executeScript(tab.id, { code: 'document.title' });`);
  await f.build();
  assert.equal(await f.read('ui/popup.html'), markup);
  assert.match(await f.read('shared.mjs'), /chrome\.scripting\.executeScript/);
  assert.equal(await f.read('webrequest-mv3-injected-1.js'), 'document.title');
  assert.deepEqual(JSON.parse(await f.read('manifest.json')).permissions, ['activeTab', 'scripting']);
});

test('stop on unsupported UI code, out-of-package paths and lifetime changes even for shared files', async t => {
  for (const [html, source, expected] of [
    ['<button onclick="run()">Run</button>', '', /popup\.html:1:1:.*inline onclick/],
    ['<script>run()</script>', '', /popup\.html:1:1:.*inline code/],
    ['<script src="../outside.js"></script>', '', /inside the extension/],
    ['<script src="bg.js"></script>', registration('() => ({cancel:true})'), /bg\.js:1:1:.*lifetime/],
    ['<script src="bg.js"></script>', 'chrome.extension.getBackgroundPage().load()', /bg\.js:1:1:.*runtime messaging/],
  ]) {
    const f = await fixture(t, source, { browser_action: { default_popup: 'popup.html' } });
    await writeFile(join(f.src, 'popup.html'), html);
    await assert.rejects(f.build(), expected);
    await assert.rejects(stat(f.out), { code: 'ENOENT' });
  }
});
