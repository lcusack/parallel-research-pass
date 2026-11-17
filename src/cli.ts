import { randomUUID } from 'node:crypto';
import { ResearchClient } from './client.ts';
import { ResearchError } from './research.ts';

const client = await ResearchClient.create();
const [command, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === 'verify') result = await client.verify();
  else if (command === 'check') result = await client.check();
  else if (command === 'status') result = await client.status();
  else if (command === 'research') {
    const idArg = args.find(a => a.startsWith('--request-id='));
    const requestId = idArg?.slice('--request-id='.length) ?? randomUUID();
    console.error(`Request ID: ${requestId}`);
    result = await client.research(args.filter(a => a !== idArg).join(' '), requestId);
  } else throw new Error('Use: npm run cli -- verify | check | status | research "question" [--request-id=UUID]');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof ResearchError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Operation failed');
  process.exitCode = 1;
} finally { client.close(); }
