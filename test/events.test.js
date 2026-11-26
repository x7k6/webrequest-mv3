import test from 'node:test';
import assert from 'node:assert/strict';
import { observe, provideAuth } from '../extension/lib/index.js';

function fakeEvent() {
  return { addListener(listener, filter, options) { Object.assign(this, { listener, filter, options }); },
    removeListener(listener) { assert.equal(listener, this.listener); delete this.listener; } };
}
const filter = { urls: ['https://example.org/*'] };

test('observations register synchronously, preserve Chrome filters and are removable', () => {
  const event = fakeEvent();
  const listener = () => {};
  const stop = observe('onCompleted', listener, filter, ['responseHeaders'], { onCompleted: event });
  assert.equal(event.listener, listener);
  assert.equal(event.filter, filter);
  assert.deepEqual(event.options, ['responseHeaders']);
  stop();
  assert.equal(event.listener, undefined);
  assert.throws(() => observe('onCompleted', listener, filter, ['blocking']), /cannot block/);
});

test('auth answers via the Chrome callback; errors and malformed credentials cancel', async () => {
  const event = fakeEvent();
  const response = { authCredentials: { username: 'demo', password: 'fixture' } };
  const stop = provideAuth(filter, ({ mode }) => {
    if (mode === 'throw') throw new Error('provider failed');
    if (mode === 'reject') return Promise.reject(new Error('provider failed'));
    if (mode === 'invalid') return { authCredentials: {} };
    if (mode === 'ok') return Promise.resolve(response);
  }, { onAuthRequired: event });
  assert.deepEqual(event.options, ['asyncBlocking']);
  const challenge = mode => new Promise(resolve => assert.equal(event.listener({ mode }, resolve), undefined));
  assert.deepEqual(await challenge('ok'), response);
  assert.deepEqual(await challenge('skip'), {});
  for (const mode of ['throw', 'reject', 'invalid']) assert.deepEqual(await challenge(mode), { cancel: true });
  stop();
  assert.equal(event.listener, undefined);
});
