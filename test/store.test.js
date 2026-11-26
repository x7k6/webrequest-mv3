import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleStore } from '../extension/lib/index.js';

const block = id => ({ id, event: 'onBeforeRequest', filter: { urls: ['*://example.org/*'] }, response: { cancel: true } });

function fixture(scope = 'dynamic') {
  let rules = [{ id: 1 }, { id: 12 }];
  let rejectUpdate = false;
  const updates = [];
  const update = async change => {
    updates.push(change);
    if (rejectUpdate) throw new Error('Chrome rejected change');
    rules = rules.filter(r => !change.removeRuleIds.includes(r.id)).concat(change.addRules);
  };
  const dnr = { isRegexSupported: async () => ({ isSupported: true }),
    // Implement only the API selected by scope: accidental writes to the other one fail.
    [scope === 'dynamic' ? 'getDynamicRules' : 'getSessionRules']: async () => rules,
    [scope === 'dynamic' ? 'updateDynamicRules' : 'updateSessionRules']: update };
  const options = { scope, dnr, firstId: 10, lastId: 19 };
  return { options, store: createRuleStore(options), ids: () => rules.map(r => r.id), updates,
    reject(value) { rejectUpdate = value; } };
}

for (const scope of ['dynamic', 'session']) {
  test(`${scope}: replace in order and clean up only owned IDs after worker restart`, async () => {
    const f = fixture(scope);
    const a = f.store.replace([block(10)]);
    const b = f.store.replace([block(11), block(13)]);
    await Promise.all([a, b]);
    assert.deepEqual(f.ids(), [1, 11, 13]);
    assert.deepEqual(f.updates.map(u => u.removeRuleIds), [[12], [10]]);
    await createRuleStore(f.options).replace([]);
    assert.deepEqual(f.ids(), [1]);
  });
}

test('invalid batch never removes existing rules; failure does not poison later writes', async () => {
  const f = fixture();
  await assert.rejects(f.store.replace([block(12), block(12)]), /Duplicate/);
  await assert.rejects(f.store.replace([block(99)]), /outside/);
  f.options.dnr.isRegexSupported = async () => ({ isSupported: false, reason: 'memoryLimitExceeded' });
  await assert.rejects(f.store.replace([block(15)]), /Rule 15: memoryLimitExceeded/);
  assert.equal(f.updates.length, 0);
  f.options.dnr.isRegexSupported = async () => ({ isSupported: true });
  f.reject(true);
  await assert.rejects(f.store.replace([block(15)]), /Chrome rejected/);
  assert.deepEqual(f.ids(), [1, 12]);
  f.reject(false);
  await f.store.replace([block(15)]);
  assert.deepEqual(f.ids(), [1, 15]);
});
