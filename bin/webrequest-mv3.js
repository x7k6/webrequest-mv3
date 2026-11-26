#!/usr/bin/env node
import { migrateExtension } from '../migration/index.js';

const args = process.argv.slice(2);
const usage = 'Usage: webrequest-mv3 <unpacked-mv2-directory> <new-mv3-directory>';
if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
  console.log(usage);
} else if (args.length !== 2) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    const { outputDir, ruleCount } = await migrateExtension(...args);
    console.log(`Created ${outputDir} with ${ruleCount} static rule(s). Load it unpacked in chrome://extensions.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
