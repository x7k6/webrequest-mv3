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
