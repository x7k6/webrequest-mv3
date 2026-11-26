import { parse } from 'acorn';
import { ancestor } from 'acorn-walk';
import { compileRule } from '../extension/lib/index.js';

const member = n => n?.type === 'MemberExpression'
  ? (n.computed ? n.property.type === 'Literal' && n.property.value : n.property.name) : undefined;

// Deliberately read a small data-only syntax. Never execute the extension in Node.
function literal(node) {
  if (node?.type === 'Literal' && ['boolean', 'number', 'string'].includes(typeof node.value)) return node.value;
  if (node?.type === 'ArrayExpression') return node.elements.map(literal);
  if (node?.type === 'ObjectExpression') {
    const result = Object.create(null);
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.kind !== 'init' || p.computed || p.method || p.shorthand) break;
      const key = p.key.name ?? p.key.value;
      if (key === '__proto__' || Object.hasOwn(result, key)) break;
      result[key] = literal(p.value);
    }
    if (Object.keys(result).length === node.properties.length) return result;
  }
  throw new Error('expected inline literal data (no variables, calls, spreads or computed properties)');
}

function ruleFor(callback, filter, id) {
  if (callback.async || callback.generator || callback.params.some(p => p.type !== 'Identifier')) {
    throw new Error('expected a synchronous callback with simple parameters');
  }
  let body = callback.body;
  if (body.type === 'BlockStatement') {
    if (body.body.length !== 1 || body.body[0].type !== 'ReturnStatement') {
      throw new Error('callback must only return a blocking response; move side effects to an observer');
    }
    body = body.body[0].argument;
  }
  const spec = { id, event: 'onBeforeRequest', filter: literal(filter) };
  const prop = body?.type === 'ObjectExpression' && body.properties.length === 1 && body.properties[0];
  const test = prop?.value;
  if (prop?.kind === 'init' && !prop.computed && (prop.key.name ?? prop.key.value) === 'cancel' &&
      test?.type === 'BinaryExpression' && test.operator === '===' && member(test.left) === 'method' &&
      test.left.object.type === 'Identifier' && test.left.object.name === callback.params[0]?.name &&
      test.right.type === 'Literal' && /^(CONNECT|DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/.test(test.right.value)) {
    spec.when = { requestMethods: [test.right.value.toLowerCase()] };
    spec.response = { cancel: true };
  } else {
    spec.response = literal(body);
  }
  return compileRule(spec);
}

export function convertBackground(source, filename, firstId) {
  let tree;
  try { tree = parse(source, { ecmaVersion: 'latest', locations: true }); }
  catch (error) { throw new Error(`${filename}:${error.loc.line}:${error.loc.column + 1}: ${error.message}`); }
  const rules = [], edits = [];
  let auth = false;
  const fail = (n, message) => { throw new Error(`${filename}:${n.loc.start.line}:${n.loc.start.column + 1}: ${message}`); };
  ancestor(tree, {
    MemberExpression(node, ancestors) {
      if (node.object.name !== 'chrome') return;
      if (member(node) === 'browserAction') edits.push([node.start, node.end, 'chrome.action']);
      if (member(node) !== 'webRequest') return;
      const [call, operation, event] = ancestors.slice(-4, -1);
      if (event?.object !== node || !member(event) || operation?.object !== event ||
          !member(operation) || call?.callee !== operation) {
        fail(node, 'use a direct chrome.webRequest.<event> method call rather than an alias');
      }
    },
    CallExpression(call, ancestors) {
      const callee = call.callee;
      if (member(callee) !== 'addListener') return;
      const event = callee.object, api = event.object;
      if (member(api) !== 'webRequest' || api.object.name !== 'chrome') {
        if (call.arguments[2]?.elements?.some(e => ['blocking', 'asyncBlocking'].includes(e?.value))) {
          fail(call, 'use chrome.webRequest.<event>.addListener directly to migrate this blocking listener');
        }
        return;
      }
      try {
        const [callback, filter, options] = call.arguments;
        const flags = options ? literal(options) : [];
        if (!Array.isArray(flags) || flags.some(f => typeof f !== 'string')) throw new Error('expected literal listener flags');
        const name = member(event);
        if (flags.includes('asyncBlocking')) {
          if (name !== 'onAuthRequired' || flags.includes('blocking')) throw new Error('asyncBlocking is only supported for auth');
          auth = true;
          return;
        }
        if (!flags.includes('blocking')) return; // Keep the native event and callback identity.
        if (!['FunctionExpression', 'ArrowFunctionExpression'].includes(callback?.type) || call.arguments.length !== 3) {
          throw new Error('expected an inline blocking callback; port named or removable listeners explicitly');
        }
        if (name === 'onAuthRequired') {
          // Keep Chrome's native challenge event and the original callback's closure.
          auth = true;
          edits.push([callback.start, callback.start, '((fn) => (details, answer) => { Promise.resolve().then(() => fn(details)).then(r => answer(r ?? {}), () => answer({cancel: true})); })('],
            [callback.end, callback.end, ')'], [options.start, options.end, JSON.stringify(flags.map(f => f === 'blocking' ? 'asyncBlocking' : f))]);
          return;
        }
        if (name !== 'onBeforeRequest') throw new Error(`port ${name} manually using explicit header edits or a DNR rule`);
        const statement = ancestors.at(-2);
        if (statement.type !== 'ExpressionStatement' || ancestors.at(-3)?.type !== 'Program') {
          throw new Error('conditional or nested registration cannot become an always-enabled rule');
        }
        const rule = ruleFor(callback, filter, firstId + rules.length);
        rules.push(rule);
        edits.push([statement.start, statement.end, `/* Migrated to static rule ${rule.id}. */;`]);
      } catch (error) { fail(call, error.message); }
    },
  });
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return { source, rules, auth };
}
