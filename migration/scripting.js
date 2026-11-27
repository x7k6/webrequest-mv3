// Build a native scripting call from an inline MV2 InjectDetails object. Only
// the tab and payload can be arbitrary expressions; both are evaluated once,
// in their original order, before the optional callback expression.
export const injectionMethods = new Set(['executeScript', 'insertCSS', 'removeCSS']);

function text(n) {
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && !n.expressions.length) return n.quasis[0].value.cooked;
}

export function rewriteInjection(method, args, read, emitScript) {
  const [tab, details, callback] = args;
  if (!tab || tab.type === 'ObjectExpression' || tab.name === 'undefined' || tab.value === null) {
    throw new Error(`tabs.${method} needs an explicit tab ID for scripting.target; pass tab.id from the event or tabs.query`);
  }
  if (args.length > 3 || args.some(n => n.type === 'SpreadElement') || details?.type !== 'ObjectExpression') {
    throw new Error(`tabs.${method} needs an inline injection details object`);
  }
  const js = method === 'executeScript';
  const allowed = ['file', 'code', 'frameId', 'allFrames', 'matchAboutBlank', 'runAt', ...(js ? [] : ['cssOrigin'])];
  const fields = new Map();
  for (const p of details.properties) {
    const name = p.key?.name ?? p.key?.value;
    if (p.type !== 'Property' || p.computed || p.method || p.kind !== 'init' ||
        !allowed.includes(name) || fields.has(name)) throw new Error(`Unsupported or duplicate injection option: ${name ?? 'spread'}`);
    fields.set(name, p.value);
  }
  if (fields.has('file') === fields.has('code')) throw new Error('Injection needs exactly one of file or code');
  if (fields.has('matchAboutBlank') && fields.get('matchAboutBlank').value !== false) {
    throw new Error('matchAboutBlank cannot be preserved by scripting; choose the intended frames explicitly');
  }
  if (fields.has('runAt') && !(js && text(fields.get('runAt')) === 'document_idle')) {
    throw new Error('Explicit runAt timing needs a manual port, e.g. a registered content script');
  }
  const target = [`tabId: ${read(tab)}`];
  if (fields.has('allFrames') && typeof fields.get('allFrames').value !== 'boolean') {
    throw new Error('allFrames must be a literal boolean');
  }
  if (fields.has('frameId')) {
    const frame = fields.get('frameId').value;
    if (!Number.isInteger(frame) || frame < 0 || fields.get('allFrames')?.value === true) {
      throw new Error('Use a literal nonnegative frameId or allFrames: true, not both');
    }
    target.push(`frameIds: [${frame}]`);
  } else if (fields.has('allFrames')) {
    target.push(`allFrames: ${fields.get('allFrames').value}`);
  }
  const options = [`target: { ${target.join(', ')} }`];
  if (fields.has('file')) options.push(`files: [${read(fields.get('file'))}]`);
  else if (!js) options.push(`css: ${read(fields.get('code'))}`);
  else {
    const source = text(fields.get('code'));
    if (source === undefined) throw new Error('Dynamic JavaScript code strings need a packaged file or a scripting func with args');
    options.push(`files: [${JSON.stringify(emitScript(source))}]`);
  }
  if (fields.has('cssOrigin')) {
    const origin = text(fields.get('cssOrigin'));
    if (!['author', 'user'].includes(origin)) throw new Error('cssOrigin must be a literal author or user');
    options.push(`origin: '${origin.toUpperCase()}'`);
  }
  const injection = `{ ${options.join(', ')} }`;
  const api = `chrome.scripting.${method}`;
  if (!js) return `${api}(${injection}${callback ? ', ' + read(callback) : ''})`;
  const values = 'results => results.map(entry => entry.result)';
  if (!callback) return `${api}(${injection}).then(${values})`;
  // Do not bridge callbacks through a Promise: runtime.lastError is only
  // readable during Chrome's callback. Capture the original callback once.
  const adapt = `(cb => cb === undefined ? undefined : results => results === undefined ? cb() : cb(results.map(entry => entry.result)))`;
  return `${api}(${injection}, ${adapt}(${read(callback)}))?.then(${values})`;
}
