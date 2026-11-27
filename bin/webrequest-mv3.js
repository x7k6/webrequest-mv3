#!/usr/bin/env node
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { migrateExtension } from '../migration/index.js';

const help = `Convert an unpacked Chrome extension from Manifest V2 to V3.

Usage: webrequest-mv3 <folder or manifest.json> [output-folder] [options]

  -o, --output <folder>   Write to a new folder (default: <input>-mv3, beside the input)
      --check             Test the conversion in a temporary copy and discard it
  -h, --help              Show this help
  -v, --version           Show the installed version

Examples:
  webrequest-mv3 ./my-extension                 Create ./my-extension-mv3
  webrequest-mv3 . --check                      Check the extension in this directory
  webrequest-mv3 ./my-extension -o ./build-mv3   Choose the output folder

Your original files stay in place. Existing output folders are never overwritten.`;

class UsageError extends Error {}

async function inputDirectory(arg) {
  let path = resolve(arg);
  const info = await stat(path).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`Input not found: ${path}\nPass the folder containing your MV2 manifest.json.`);
    throw error;
  });
  if (info.isFile() && basename(path) === 'manifest.json') path = dirname(path);
  else if (!info.isDirectory()) throw new Error('Pass an unpacked extension folder or its manifest.json file.');
  const manifestPath = join(path, 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error(`No manifest.json in ${path}. If you use a bundler, pass its packaged output folder.`);
    throw error;
  });
  let data;
  try { data = JSON.parse(manifest); }
  catch (error) { throw new Error(`Invalid JSON in ${manifestPath}: ${error.message}`); }
  if (data?.manifest_version === 3) throw new Error(`${manifestPath} is already Manifest V3.`);
  if (data?.manifest_version !== 2) throw new Error(`${manifestPath}: expected manifest_version: 2.`);
  return realpath(path);
}

async function checkConversion(input) {
  const scratch = await mkdtemp(join(tmpdir(), 'webrequest-mv3-check-'));
  try {
    return await migrateExtension(input, join(scratch, 'extension'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function run(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      check: { type: 'boolean' }, output: { type: 'string', short: 'o', multiple: true },
    } });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { positionals, values } = parsed;
  if (values.help || !args.length) return console.log(help);
  if (values.version) return console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  if (!positionals[0]) throw new UsageError('Pass an extension folder, or use . for the current directory.');
  if (positionals.length > 2) throw new UsageError('Too many paths. Quote folder names that contain spaces.');
  if (values.output?.length > 1 || (values.output && positionals.length === 2)) throw new UsageError('Specify the output once, either as a second path or with --output.');
  const destination = values.output?.[0] ?? positionals[1];
  if (destination === '') throw new UsageError('The output folder name cannot be empty.');
  if (values.check && destination !== undefined) throw new UsageError('--check uses a temporary copy. Omit the output folder to check the conversion.');

  const input = await inputDirectory(positionals[0]);
  let result;
  if (values.check) {
    result = await checkConversion(input);
    console.log('Conversion check passed. The temporary copy was removed.');
  } else {
    const output = destination === undefined ? input + '-mv3' : resolve(destination);
    // The converter also creates the destination exclusively. This preflight
    // provides actionable messages without masking errors inside the build.
    if (await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      throw new Error(`Output already exists: ${output}\nChoose a new folder with --output. Nothing was overwritten.`);
    }
    const parent = await stat(dirname(output)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!parent?.isDirectory()) throw new Error(`Create the parent folder first: ${dirname(output)}`);
    result = await migrateExtension(input, output);
    console.log(`Created MV3 extension: ${result.outputDir}`);
  }
  console.log(`Scripts updated: ${result.changedScriptCount} of ${result.scriptCount} inspected. Static network rules: ${result.ruleCount}.`);
  if (!values.check) console.log('Next: Open chrome://extensions, enable Developer mode, then select Load unpacked and choose the folder above.');
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  if (error instanceof UsageError) console.error('Run webrequest-mv3 --help for examples.');
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
