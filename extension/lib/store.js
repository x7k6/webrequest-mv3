import { compileRule, integer } from './compile.js';

// Give each store an exclusive, inclusive ID range in its chosen ruleset.
// Keep one instance per range in the service worker (the single writer).
export function createRuleStore({ firstId, lastId, scope = 'dynamic', dnr = globalThis.chrome?.declarativeNetRequest }) {
  integer(firstId, 1, 'firstId');
  integer(lastId, firstId, 'lastId');
  if (!['dynamic', 'session'].includes(scope)) throw new TypeError('Unknown rule scope');
  if (!dnr) throw new Error('declarativeNetRequest API unavailable; check manifest permissions');
  const session = scope === 'session';
  const inRange = id => id >= firstId && id <= lastId;
  let tail = Promise.resolve();

  return {
    async replace(specs) {
      if (!Array.isArray(specs)) throw new TypeError('replace expects an array of rule descriptions');
      const ids = new Set();
      const addRules = Array.from(specs, spec => {
        const rule = compileRule(spec, scope);
        if (!inRange(rule.id)) throw new RangeError(`Rule ${rule.id} outside store range`);
        if (ids.has(rule.id)) throw new Error(`Duplicate rule ID: ${rule.id}`);
        ids.add(rule.id);
        return rule;
      });

      const job = tail.then(async () => {
        for (const { id, condition } of addRules) {
          const check = await dnr.isRegexSupported({ regex: condition.regexFilter, isCaseSensitive: true });
          if (!check.isSupported) throw new Error(`Rule ${id}: ${check.reason || 'unsupported regex'}`);
        }
        const current = await (session ? dnr.getSessionRules() : dnr.getDynamicRules());
        const removeRuleIds = current.map(rule => rule.id).filter(inRange);
        if (!removeRuleIds.length && !addRules.length) return;
        // One atomic update. A rejected replacement leaves the old rules live.
        const update = { removeRuleIds, addRules };
        await (session ? dnr.updateSessionRules(update) : dnr.updateDynamicRules(update));
      });
      tail = job.catch(() => {}); // A failed write must not poison the queue.
      return job;
    },
  };
}
