import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/webrequest-mv3.js', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wr-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../examples/legacy/', import.meta.url), join(dir, 'my extension'), { recursive: true });
  const temp = join(dir, 'temp');
  await mkdir(temp);
  return { dir, temp, run: (...args) => exec(process.execPath, [cli, ...args], {
    cwd: dir, env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
  }) };
}

test('CLI accepts a manifest path, chooses a sibling, and protects previous output', async t => {
  const { dir, run } = await fixture(t);
  const { stdout } = await run('my extension/manifest.json');
  assert.match(stdout, /Static network rules: 2/);
  const manifest = name => readFile(join(dir, name, 'manifest.json'), 'utf8').then(JSON.parse);
  assert.equal((await manifest('my extension-mv3')).manifest_version, 3);
  assert.equal((await manifest('my extension')).manifest_version, 2);
  await assert.rejects(run('my extension'), { code: 1, stderr: /Output already exists:.*my extension-mv3/ });
  await run('my extension', '-o', 'another folder');
  assert.equal((await manifest('another folder')).manifest_version, 3);
  await run('my extension', 'legacy syntax');
  assert.equal((await manifest('legacy syntax')).manifest_version, 3);
});

test('CLI check runs the actual conversion and discards the copy on success or failure', async t => {
  const { dir, temp, run } = await fixture(t);
  assert.match((await run('--check', 'my extension')).stdout, /Static network rules: 2/);
  await writeFile(join(dir, 'my extension', 'background.js'), 'chrome.tabs.executeScript({code: "1"});');
  await assert.rejects(run('my extension', '--check'), { code: 1, stderr: /background\.js:1:1:.*tab ID/ });
  assert.deepEqual(await readdir(temp), []);
  assert.deepEqual((await readdir(dir)).sort(), ['my extension', 'temp']);
  await assert.rejects(run('my extension', 'out', '--output', 'other'), { code: 2, stderr: /Specify the output once/ });
});
