import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { convertScript } from './script.js';
import { discoverEntries } from './entries.js';

const worker = 'webrequest-mv3-worker.js';
const rulesFile = 'webrequest-mv3-rules.json';
const json = value => JSON.stringify(value, null, 2) + '\n';

function convertManifest(m, rules, auth, scripting, workerPath) {
  if (m.page_action || m.app || m.declarative_net_request) {
    throw new Error('manifest.json: page actions, apps and existing DNR rulesets need manual migration');
  }
  if (m.optional_permissions?.includes('webRequestBlocking')) {
    throw new Error('manifest.json: optional blocking needs a permission-aware dynamic ruleset');
  }
  if (rules.length && !m.permissions?.includes('webRequestBlocking')) {
    throw new Error('manifest.json: refusing to enable rules without an existing webRequestBlocking permission');
  }
  for (const [permissions, hosts] of [['permissions', 'host_permissions'], ['optional_permissions', 'optional_host_permissions']]) {
    if (!m[permissions]) continue;
    const isHost = p => p === '<all_urls>' || p.includes('://');
    const patterns = m[permissions].filter(isHost);
    if (patterns.length) m[hosts] = [...new Set([...(m[hosts] || []), ...patterns])];
    m[permissions] = m[permissions].filter(p => !isHost(p) && p !== 'webRequestBlocking');
  }
  const permissions = new Set(m.permissions);
  if (auth) permissions.add('webRequestAuthProvider');
  if (scripting) permissions.add('scripting');
  if (rules.length) {
    permissions.add('declarativeNetRequestWithHostAccess');
    m.declarative_net_request = { rule_resources: [{ id: 'migrated', enabled: true, path: rulesFile }] };
  }
  m.permissions = [...permissions];
  if (m.options_page) {
    if (m.options_ui) throw new Error('manifest.json: choose either options_page or options_ui');
    m.options_ui = { page: m.options_page, open_in_tab: true };
    delete m.options_page;
  }
  if (m.browser_action) {
    m.action = m.browser_action;
    delete m.browser_action;
    if (m.commands?._execute_browser_action) {
      m.commands._execute_action = m.commands._execute_browser_action;
      delete m.commands._execute_browser_action;
    }
  }
  if (m.web_accessible_resources?.length) {
    m.web_accessible_resources = [{ resources: m.web_accessible_resources, matches: ['<all_urls>'] }];
  }
  if (m.content_security_policy) {
    if (/unsafe-eval|unsafe-inline|https?:|\bdata:/i.test(m.content_security_policy)) {
      throw new Error('manifest.json: review content_security_policy for MV3; remote scripts and unsafe-eval are not supported');
    }
    m.content_security_policy = { extension_pages: m.content_security_policy };
  }
  m.manifest_version = 3;
  if (!(parseInt(m.minimum_chrome_version, 10) >= 120)) m.minimum_chrome_version = '120';
  if (workerPath) m.background = { service_worker: workerPath };
}

/** Build a new unpacked extension from a directory containing an MV2 manifest. */
export async function migrateExtension(inputDir, outputDir) {
  const input = await realpath(inputDir);
  const output = join(await realpath(dirname(resolve(outputDir))), basename(resolve(outputDir)));
  const rel = relative(input, output);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('Choose an output directory outside the input extension');
  // Exclusive creation: never overwrite an extension, even on a failed build.
  await mkdir(output);
  try {
    await cp(input, output, { recursive: true, filter: async path => {
      if (path !== input && ['.git', 'node_modules', '.DS_Store', '_metadata'].includes(basename(path))) return false;
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Package real files instead of symlinks: ${relative(input, path)}`);
      return true;
    } });
    const manifestPath = join(output, 'manifest.json');
    const m = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (m.manifest_version !== 2) throw new Error('Expected an MV2 manifest.json');
    const { entries, imports, directory, fromPage } = await discoverEntries(output, m);
    const rules = [];
    let auth = false, scripting = false;
    const injected = new Map();
    const emitScript = source => {
      const path = `webrequest-mv3-injected-${injected.size + 1}.js`;
      injected.set(path, source);
      return path;
    };
    for (const [name, entry] of entries) {
      const path = join(output, name);
      const old = await readFile(path, 'utf8');
      const converted = convertScript(old, name, rules.length + 1, emitScript, { ...entry, fromPage });
      if (converted.source !== old) await writeFile(path, converted.source);
      for (const rule of converted.rules) rules.push(rule);
      auth ||= converted.auth;
      scripting ||= converted.scripting;
    }
    // Keep relative URLs in the scripts based in the original page directory.
    const workerPath = imports.length ? posix.join(directory, worker) : undefined;
    convertManifest(m, rules, auth, scripting, workerPath);
    for (const [path, contents] of injected) await writeFile(join(output, path), contents, { flag: 'wx' });
    if (rules.length) await writeFile(join(output, rulesFile), json(rules), { flag: 'wx' });
    if (workerPath) {
      const urls = imports.map(name => JSON.stringify('./' + posix.relative(directory, name)));
      await writeFile(join(output, workerPath), `importScripts(${urls.join(', ')});\n`, { flag: 'wx' });
    }
    await writeFile(manifestPath, json(m));
    return { outputDir: output, ruleCount: rules.length };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
