const observable = new Set([
  'onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived',
  'onAuthRequired', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred',
]);

function register(event, listener, filter, options) {
  if (!event) throw new Error('webRequest event unavailable; check manifest permissions');
  event.addListener(listener, filter, options);
  return () => event.removeListener(listener);
}

// Register at service-worker module scope, before any await.
export function observe(name, listener, filter, options = [], webRequest = globalThis.chrome?.webRequest) {
  if (!observable.has(name)) throw new TypeError(`Unknown observation event: ${name}`);
  if (!Array.isArray(options) || options.some(o => o === 'blocking' || o === 'asyncBlocking')) {
    throw new TypeError('Observation cannot block; use a rule or provideAuth');
  }
  return register(webRequest?.[name], listener, filter, options);
}

// The one MV3 event that can wait for application code. Chrome expects a
// callback, not a Promise. A provider failure cancels just this challenge.
export function provideAuth(filter, provider, webRequest = globalThis.chrome?.webRequest) {
  if (typeof provider !== 'function') throw new TypeError('Expected an auth provider function');
  function listener(details, respond) {
    Promise.resolve().then(() => provider(details)).then(result => {
      if (result == null) return {};
      if (result.cancel === true) return { cancel: true };
      const creds = result.authCredentials;
      if (typeof creds?.username === 'string' && typeof creds.password === 'string') {
        return { authCredentials: { username: creds.username, password: creds.password } };
      }
      throw new TypeError('Invalid auth response');
    }).then(respond, () => respond({ cancel: true }));
  }
  return register(webRequest?.onAuthRequired, listener, filter, ['asyncBlocking']);
}
