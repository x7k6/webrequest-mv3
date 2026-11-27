import { localPath, readBackgroundPage, readUiPage } from './page.js';

// Collect every declared use before rewriting shared files. A rule extracted
// from a background script must never become permanent on behalf of a popup.
export async function discoverEntries(root, m) {
  const entries = new Map(), imports = [];
  const add = (name, context, sourceType = 'script') => {
    const entry = entries.get(name) || { contexts: new Set(), sourceType };
    if (sourceType !== entry.sourceType) throw new Error(`${name}: shared classic/module scripts need a manual port`);
    entry.contexts.add(context);
    entries.set(name, entry);
  };
  let directory = '.';
  const fromPage = m.background?.page !== undefined;
  if (m.background !== undefined) {
    if (fromPage && m.background.scripts !== undefined) throw new Error('manifest.json: choose background.page or background.scripts, not both');
    let scripts = m.background?.scripts;
    if (fromPage) ({ scripts, directory } = await readBackgroundPage(root, m.background.page));
    if (!Array.isArray(scripts) || !scripts.length) throw new Error('Expected a background.scripts list or a script-only background.page');
    for (const path of scripts) {
      const name = typeof path === 'string' && path.replace(/^(\.\/)+/, '');
      if (!name || /[\\:%?#\x00-\x1f]/.test(name) || name.split('/').some(p => !p || p === '..' || p === '.')) {
        throw new Error('manifest.json: background.scripts must use package-relative paths');
      }
      if (imports.includes(name)) throw new Error(`Duplicate background script: ${name}`);
      imports.push(name);
      add(name, 'background');
    }
  }
  const pages = new Set();
  for (const path of [m.browser_action?.default_popup, m.options_page, m.options_ui?.page, m.devtools_page,
    ...Object.values(m.chrome_url_overrides || {})]) {
    if (path !== undefined && path !== '') pages.add(localPath(path, '.', 'manifest.json: extension page'));
  }
  for (const page of pages) {
    for (const { name, sourceType } of await readUiPage(root, page)) add(name, 'ui', sourceType);
  }
  for (const group of m.content_scripts || []) {
    for (const path of group.js || []) add(localPath(path, '.', 'manifest.json: content_scripts.js'), 'content');
  }
  return { entries, imports, directory, fromPage };
}
