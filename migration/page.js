import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { parse } from 'parse5';

// Work with extension URL paths, independent of the host filesystem. Resolve
// ../ relative to the HTML file, but never read outside the copied package.
export function localPath(value, directory, where) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\:%?#\x00-\x1f]/.test(value) || value.startsWith('//')) {
    throw new Error(`${where}: expected a local extension file path`);
  }
  const name = posix.normalize(value.startsWith('/') ? value.slice(1) : posix.join(directory, value));
  if (name === '..' || name.startsWith('../') || name === '.' || name.endsWith('/')) {
    throw new Error(`${where}: path must name a file inside the extension`);
  }
  return name;
}

async function readDocument(root, page) {
  const html = await readFile(posix.join(root, page), 'utf8');
  return parse(html, { sourceCodeLocationInfo: true, onParseError(error) {
    if (error.code !== 'missing-doctype') throw new Error(`${page}:${error.startLine}:${error.startCol}: ${error.code}`);
  } });
}

// UI documents stay documents. Inspect executable script tags in place; don't
// reserialize markup, change loading order, or treat inert template data as JS.
export async function readUiPage(root, page) {
  const scripts = [];
  function visit(node) {
    const loc = node.sourceCodeLocation;
    const where = loc ? `${page}:${loc.startLine}:${loc.startCol}` : page;
    const attrs = new Map(node.attrs?.map(a => [a.name, a.value]));
    if (node.tagName === 'base' && attrs.has('href')) throw new Error(`${where}: resolve <base href> script paths manually`);
    for (const key of attrs.keys()) {
      if (key.startsWith('on')) throw new Error(`${where}: move inline ${key} into a packaged event listener`);
    }
    if (node.tagName === 'script') {
      const type = (attrs.get('type') || '').toLowerCase().trim();
      if (['application/json', 'application/ld+json', 'text/template'].includes(type)) return;
      const module = type === 'module';
      if ((!module && !['', 'text/javascript', 'application/javascript'].includes(type)) || attrs.has('integrity')) {
        throw new Error(`${where}: unsupported script type or integrity constraint; review this script manually`);
      }
      if (!attrs.has('src')) {
        if (node.childNodes.some(n => n.value?.trim())) throw new Error(`${where}: move executable inline code into a packaged script file`);
        return;
      }
      scripts.push({ name: localPath(attrs.get('src'), posix.dirname(page), where), sourceType: module ? 'module' : 'script' });
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(await readDocument(root, page));
  return scripts;
}

export async function readBackgroundPage(root, entry) {
  const page = localPath(entry, '.', 'manifest.json: background.page');
  const directory = posix.dirname(page);
  const doc = await readDocument(root, page);
  const scripts = [];
  function visit(node) {
    const tag = node.nodeName;
    const loc = node.sourceCodeLocation;
    const where = loc ? `${page}:${loc.startLine}:${loc.startCol}` : page;
    const fail = reason => { throw new Error(`${where}: ${reason}`); };
    const attrs = new Map((node.attrs || []).map(a => [a.name, a.value]));
    const only = (...keys) => {
      for (const key of attrs.keys()) if (!keys.includes(key)) fail(`unsupported <${tag}> attribute: ${key}`);
    };
    switch (tag) {
      case '#documentType': case '#comment': return;
      case '#text':
        if (node.value.trim()) fail('background page contains text that needs a document');
        return;
      case '#document': break;
      case 'html': only('lang'); break;
      case 'head': case 'body': only(); break;
      case 'title': only(); return;
      case 'meta':
        only('charset');
        if (attrs.get('charset')?.toLowerCase() !== 'utf-8') fail('only <meta charset="utf-8"> is supported');
        return;
      case 'script': {
        only('src', 'type');
        if (!['', 'text/javascript', 'application/javascript'].includes((attrs.get('type') || '').trim().toLowerCase())) {
          fail('use a classic JavaScript script, or port this script type manually');
        }
        if (!attrs.has('src') || node.childNodes.some(n => n.value?.trim())) fail('move inline script code into a packaged .js file');
        const name = localPath(attrs.get('src'), directory, where);
        if (!name.toLowerCase().endsWith('.js')) fail('expected a packaged .js script');
        if (scripts.includes(name)) fail(`duplicate background script: ${name}`);
        scripts.push(name);
        return;
      }
      default: fail(`background page element <${tag}> needs a manual port`);
    }
    for (const child of node.childNodes) visit(child);
  }
  visit(doc);
  if (!scripts.length) throw new Error(`${page}: expected at least one <script src> with a packaged .js file`);
  return { scripts, directory };
}
