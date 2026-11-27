import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { parse } from 'parse5';

// Work with extension URL paths, independent of the host filesystem. Resolve
// ../ relative to the HTML file, but never read outside the copied package.
function localPath(value, directory, where) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\:%?#\x00-\x1f]/.test(value) || value.startsWith('//')) {
    throw new Error(`${where}: expected a local extension file path`);
  }
  const name = posix.normalize(value.startsWith('/') ? value.slice(1) : posix.join(directory, value));
  if (name === '..' || name.startsWith('../') || name === '.' || name.endsWith('/')) {
    throw new Error(`${where}: path must name a file inside the extension`);
  }
  return name;
}

export async function readBackgroundPage(root, entry) {
  const page = localPath(entry, '.', 'manifest.json: background.page');
  const directory = posix.dirname(page);
  const html = await readFile(posix.join(root, page), 'utf8');
  const doc = parse(html, { sourceCodeLocationInfo: true, onParseError(error) {
    if (error.code !== 'missing-doctype') throw new Error(`${page}:${error.startLine}:${error.startCol}: ${error.code}`);
  } });
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
