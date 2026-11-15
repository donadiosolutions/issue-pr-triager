import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/index.js';

const node = '/home/bcdonadio/.nvm/versions/node/v24.22.3/bin/node';

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('main returns success when action succeeds', async () => {
  let invoked = 0;
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main({}, { runAction: async () => { invoked += 1; }, log: assert.fail });
    assert.equal(code, 0);
    assert.equal(invoked, 1);
    assert.equal(process.exitCode, undefined);
  } finally { process.exitCode = exitCode; }
});

test('main redacts credentials and records failure exit code', async () => {
  let line = '';
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main({ 'INPUT_GITHUB-TOKEN': 'secret-x', 'INPUT_OPENAI-API-TOKEN': 'secret-y' }, {
      runAction: async () => { throw new Error('bad secret-x secret-y'); },
      log: (value) => { line = value; }
    });
    assert.equal(code, 1);
    assert.equal(process.exitCode, 1);
    assert.equal(line, '::error::bad [REDACTED] [REDACTED]');
  } finally { process.exitCode = exitCode; }
});

test('real entrypoint fails safely on invalid invocation', async () => {
  const result = await runCli(['src/index.js'], { cwd: process.cwd(), env: { ...process.env, GITHUB_REPOSITORY: 'org/repo', 'INPUT_GITHUB-TOKEN': 'cli-secret' } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /GITHUB_EVENT_PATH is required/);
  assert.doesNotMatch(result.stderr, /cli-secret/);
});

test('real entrypoint succeeds in enroll mode with mocked HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'triager-cli-'));
  try {
    const eventPath = join(directory, 'event.json');
    const outputPath = join(directory, 'output');
    const summaryPath = join(directory, 'summary');
    await writeFile(eventPath, JSON.stringify({ action: 'opened', issue: { number: 3 } }));
    const result = await runCli(['--import', './test/fixtures/runtime-preload.mjs', 'src/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'org/repo', GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'issues',
        GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath, RUNNER_TEMP: directory,
        'INPUT_GITHUB-TOKEN': 'fake-gh', 'INPUT_PROJECT-NUMBER': '7', INPUT_MODE: 'enroll', 'INPUT_DRY-RUN': 'true'
      }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(outputPath, 'utf8'), /processed=/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('main sanitizes thrown non-Error values and leaves absent secrets alone', async () => {
  let line = '';
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main({}, { runAction: async () => { throw 'untyped failure'; }, log: (value) => { line = value; } });
    assert.equal(code, 1);
    assert.equal(line, '::error::untyped failure');
  } finally { process.exitCode = exitCode; }
});

test('main escapes workflow command characters after credential redaction', async () => {
  let line = '';
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await main({ 'INPUT_GITHUB-TOKEN': 'token%', 'INPUT_OPENAI-API-TOKEN': 'openai' }, {
      runAction: async () => { throw new Error('bad token%\r\nopenai'); },
      log: (value) => { line = value; }
    });
    assert.equal(line, '::error::bad [REDACTED]%0D%0A[REDACTED]');
  } finally { process.exitCode = exitCode; }
});
