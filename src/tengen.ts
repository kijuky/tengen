#!/usr/bin/env node

import { startServer } from './server.ts';
import { buildMaliciousDB } from './scripts/build-malicious-db.ts';

const [, , subcommand, ...args] = process.argv;

if (subcommand === 'serve') {
  startServer(args);
} else if (subcommand === 'build-malicious-db') {
  await buildMaliciousDB();
} else {
  const prefix = subcommand ? `Unknown subcommand: ${subcommand}\n\n` : '';
  process.stderr.write(
    `${prefix}Usage: tengen <command> [options]\n\nCommands:\n  serve              Start the registry proxy server\n  build-malicious-db Build the malicious package database\n\nRun 'tengen serve --help' for server options.\n`,
  );
  process.exit(1);
}
