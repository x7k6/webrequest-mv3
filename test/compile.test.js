import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRule } from '../extension/lib/index.js';

const block = urls => ({ id: 10, event: 'onBeforeRequest', filter: { urls }, response: { cancel: true } });

test('exact host, optional port, case-sensitive path/query and regex literals', () => {
  const re = new RegExp(compileRule(block(['https://Example.org/Path?q=[a]*'])).condition.regexFilter);
  for (const url of ['https://example.org/Path?q=[a]', 'https://example.org.:8080/Path?q=[a]abc']) {
    assert.match(url, re);
  }
  for (const url of ['http://example.org/Path?q=[a]', 'https://example.org/path?q=[a]',
    'https://example.org/Path?q=a', 'https://sub.example.org/Path?q=[a]',
    'https://other.test/@example.org/Path?q=[a]', 'https://example.org@other.test/Path?q=[a]']) {
    assert.doesNotMatch(url, re);
  }
});

test('match pattern alternatives preserve host boundaries, schemes and directory roots', () => {
  const re = new RegExp(compileRule(block(['*://*.example.org/dir/*', 'wss://*/*'])).condition.regexFilter);
  for (const url of ['http://example.org/dir', 'https://a.b.example.org/dir/file', 'wss://[::1]:8080/']) assert.match(url, re);
  for (const url of ['ws://example.org/dir/', 'https://notexample.org/dir/a', 'https://example.org/dirs/',
    'http://a.test/?host=b.example.org/dir/', 'https://example.org.test/dir/']) assert.doesNotMatch(url, re);
});

test('all-URL filters include navigations, but not privileged Chrome UI', () => {
  const { condition } = compileRule(block(['<all_urls>']));
  assert.ok(condition.resourceTypes.includes('main_frame'));
  const re = new RegExp(condition.regexFilter);
  assert.match('file:///notes.txt', re);
  assert.doesNotMatch('chrome://settings/', re);
});

test('port a conditional callback to a scoped session rule', () => {
  const spec = { ...block(['<all_urls>']), filter: { urls: ['<all_urls>'], types: ['image'], tabId: 42 },
    when: { requestMethods: ['post'], domainType: 'thirdParty', initiatorDomains: ['Example.org'] } };
  assert.throws(() => compileRule(spec), /session/);
  const { condition } = compileRule(spec, 'session');
  assert.deepEqual(condition.tabIds, [42]);
  assert.deepEqual(condition.resourceTypes, ['image']);
  assert.deepEqual(condition.requestMethods, ['post']);
  assert.equal(condition.domainType, 'thirdParty');
  assert.deepEqual(condition.initiatorDomains, ['example.org']);
});

test('reject unsupported conditions instead of dropping them or running callbacks', () => {
  const spec = block(['<all_urls>']);
  assert.throws(() => compileRule({ ...spec, filter: { ...spec.filter, windowId: 1 } }), /windowId/);
  assert.throws(() => compileRule({ ...spec, when: { requestBody: 'yes' } }), /requestBody/);
  assert.throws(() => compileRule({ ...spec, response: () => assert.fail('executed callback') }), /must be an object/);
  assert.throws(() => compileRule(block(['<all_urls>', 'http://bad:1234/*'])), /Unsupported host/);
  assert.throws(() => compileRule(block([])), /nonempty/);
  assert.throws(() => compileRule({ ...spec, response: { cancel: false } }), /cancel: true/);
  assert.throws(() => compileRule({ ...spec, response: { redirectUrl: 'javascript:void(0)' } }), /HTTP\(S\)/);
});

test('require explicit header operations at the correct stage', () => {
  const spec = { ...block(['<all_urls>']), event: 'onHeadersReceived' };
  const edits = [{ header: 'X-Old', operation: 'remove' }, { header: 'X-New', operation: 'set', value: '1' }];
  assert.deepEqual(compileRule({ ...spec, response: { responseHeaders: edits } }).action,
    { type: 'modifyHeaders', responseHeaders: edits });
  for (const response of [{ requestHeaders: edits }, { responseHeaders: [{ name: 'X-Old', value: '2' }] },
    { responseHeaders: [{ header: 'X-New', operation: 'set', value: 'ok\r\nBroken' }] }, { cancel: true }]) {
    assert.throws(() => compileRule({ ...spec, response }));
  }
});
