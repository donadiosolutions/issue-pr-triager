import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runAction } from './action.js';

function sanitize(error, env) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of ['INPUT_GITHUB-TOKEN', 'INPUT_OPENAI-API-TOKEN']) {
    const secret = env[name];
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export async function main(env = process.env, dependencies = {}) {
  const execute = dependencies.runAction ?? runAction;
  const log = dependencies.log ?? ((line) => console.error(line));
  try {
    await execute(env, dependencies.actionDependencies ?? {});
    return 0;
  } catch (error) {
    log(`::error::${sanitize(error, env)}`);
    process.exitCode = 1;
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
