// Compile data, not listener functions. Chrome evaluates the result without
// waking the extension's service worker.
const resourceTypes = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
];

function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unsupported ${label}.${key}`);
  }
}

function list(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty array`);
  }
  return Array.from(value);
}

export function integer(value, min, label) {
  if (!Number.isInteger(value) || value < min || value > 0x7fffffff) {
    throw new TypeError(`${label} must be an integer from ${min} to 2147483647`);
  }
  return value;
}

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const allSchemes = '(https?|wss?|ftp|file)://';

function patternSource(pattern) {
  if (pattern === '<all_urls>') return allSchemes + '.*';
  if (typeof pattern !== 'string' || /[^\x21-\x7e]|[#\\]/.test(pattern)) {
    throw new TypeError('Expected an ASCII URL match pattern without a fragment or backslash');
  }
  const parts = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!parts) throw new TypeError(`Unsupported URL match pattern: ${pattern}`);
  const [, scheme, host, path] = parts;
  const pathRegex = path.split('*').map(escapeRegex).join('[^#]*');
  // Chrome match patterns also treat /dir/* as matching the bare /dir.
  const pathPart = path.endsWith('/*') && path !== '/*' && !path.slice(0, -2).includes('*')
    ? pathRegex.slice(0, -'/[^#]*'.length) + '(/[^#]*)?'
    : pathRegex;
  if (scheme === 'file') {
    if (host) throw new TypeError('Use file:///path for a file match pattern');
    return `file://[^/?#]*${pathPart}`;
  }

  let hostPart;
  if (host === '*') {
    hostPart = '([^:/?#@]+|\\[[0-9a-f:.]+\\])';
  } else {
    const wildcard = host.startsWith('*.');
    const name = (wildcard ? host.slice(2) : host).toLowerCase();
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name)) {
      throw new TypeError(`Unsupported host in match pattern: ${host}`);
    }
    // Reject noncanonical spellings (e.g. abbreviated IPv4) rather than
    // producing a rule that can never match Chrome's serialized URL.
    if (new URL(`http://${name}/`).hostname !== name || (wildcard && /^\d+(\.\d+)*$/.test(name))) {
      throw new TypeError(`Use a canonical host in match pattern: ${host}`);
    }
    hostPart = (wildcard ? '([^./:@?#]+\\.)*' : '') + escapeRegex(name) + '\\.*';
  }
  // The optional userinfo prefix must end at @ *inside* the authority;
  // an @ in a path or query cannot turn an unrelated host into a match.
  return `${scheme === '*' ? 'https?' : scheme}://([^/?#@]*@)?${hostPart}(:[0-9]+)?${pathPart}`;
}

function conditionFor(filter, scope) {
  keys(filter, ['urls', 'types', 'tabId'], 'filter');
  const sources = [...new Set(list(filter.urls, 'filter.urls').map(patternSource))];
  const types = filter.types === undefined ? resourceTypes : list(filter.types, 'filter.types');
  if (types.some(type => !resourceTypes.includes(type))) throw new TypeError('Unsupported resource type');
  // Explicitly include main_frame: DNR's default omits it, webRequest's doesn't.
  const condition = { resourceTypes: [...new Set(types)] };
  if (sources.includes(allSchemes + '.*')) {
    condition.regexFilter = '^' + allSchemes;
  } else {
    condition.regexFilter = `^(${sources.join('|')})(#.*)?$`;
  }
  condition.isUrlFilterCaseSensitive = true;
  if (filter.tabId !== undefined) {
    if (scope !== 'session') throw new TypeError('tabId requires a session rule');
    condition.tabIds = [integer(filter.tabId, 0, 'filter.tabId')];
  }
  return condition;
}

// Common predicates that used to live inside a listener's JavaScript body.
function predicates(when) {
  keys(when, ['requestMethods', 'initiatorDomains', 'domainType'], 'when');
  const result = {};
  if (when.requestMethods !== undefined) {
    const methods = list(when.requestMethods, 'requestMethods');
    const supported = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other'];
    if (!methods.every(m => supported.includes(m))) throw new TypeError('Expected lowercase DNR request methods');
    result.requestMethods = [...new Set(methods)];
  }
  if (when.initiatorDomains !== undefined) {
    const domains = list(when.initiatorDomains, 'initiatorDomains');
    if (!domains.every(d => typeof d === 'string' && /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i.test(d))) {
      throw new TypeError('Expected bare ASCII initiator domain names');
    }
    result.initiatorDomains = [...new Set(domains.map(d => d.toLowerCase()))];
  }
  if (when.domainType !== undefined) {
    if (!['firstParty', 'thirdParty'].includes(when.domainType)) throw new TypeError('Unknown domainType');
    result.domainType = when.domainType;
  }
  return result;
}

function headerEdit(edit) {
  keys(edit, ['header', 'operation', 'value'], 'header edit');
  const { header, operation, value } = edit;
  if (typeof header !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) {
    throw new TypeError('Invalid HTTP header name');
  }
  if (operation === 'remove' && value === undefined) return { header, operation };
  if (['set', 'append'].includes(operation) && typeof value === 'string' && !/[\r\n\0]/.test(value)) {
    return { header, operation, value };
  }
  throw new TypeError('Use remove without a value or set/append with a single-line string value');
}

function actionFor(event, response) {
  switch (event) {
    case 'onBeforeRequest': {
      keys(response, ['cancel', 'redirectUrl'], 'response');
      if (Object.keys(response).length !== 1) throw new TypeError('Specify one blocking response');
      if (response.cancel === true) return { type: 'block' };
      if (typeof response.redirectUrl === 'string') {
        const url = new URL(response.redirectUrl);
        if (['http:', 'https:'].includes(url.protocol)) {
          return { type: 'redirect', redirect: { url: url.href } };
        }
      }
      throw new TypeError('Use cancel: true or an absolute HTTP(S) redirectUrl');
    }
    case 'onBeforeSendHeaders':
    case 'onHeadersReceived': {
      const field = event === 'onBeforeSendHeaders' ? 'requestHeaders' : 'responseHeaders';
      keys(response, [field], 'response');
      return { type: 'modifyHeaders', [field]: list(response[field], field).map(headerEdit) };
    }
    default: throw new TypeError(`Unsupported declarative event: ${event}`);
  }
}

export function compileRule(spec, scope = 'dynamic') {
  if (!['dynamic', 'session'].includes(scope)) throw new TypeError('Unknown rule scope');
  keys(spec, ['id', 'priority', 'event', 'filter', 'when', 'response'], 'rule');
  return {
    id: integer(spec.id, 1, 'id'),
    priority: integer(spec.priority === undefined ? 1 : spec.priority, 1, 'priority'),
    condition: { ...conditionFor(spec.filter, scope), ...predicates(spec.when === undefined ? {} : spec.when) },
    action: actionFor(spec.event, spec.response),
  };
}
