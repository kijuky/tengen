#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { startServer } from './server.ts';
import { buildMaliciousDB } from './scripts/build-malicious-db.ts';

const [, , subcommand, ...args] = process.argv;

if (subcommand === 'serve') {
  await startServer(args);
} else if (subcommand === 'build-malicious-db') {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: 'string', short: 'o' },
    },
  });
  if (!values.output) {
    process.stderr.write('Error: --output (-o) is required\n');
    process.exit(1);
  }
  await buildMaliciousDB(values.output);
} else {
  const prefix = subcommand ? `Unknown subcommand: ${subcommand}\n\n` : '';
  process.stderr.write(
    `${prefix}Usage: tengen <command> [options]\n\nCommands:\n  serve                               Start the registry proxy server\n  build-malicious-db -o <path>       Build the malicious package database\n\nOptions for build-malicious-db:\n  -o, --output <path>   Output file path (required)\n\nRun 'tengen serve --help' for server options.\n`,
  );
  process.exit(1);
}
