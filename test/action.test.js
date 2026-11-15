import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAction } from '../src/action.js';

async function setup({ inputs = {}, event = { action: 'opened' }, eventName = 'issues' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'triager-action-'));
  const eventPath = join(directory, 'event.json');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(eventPath, JSON.stringify(event)));
  const env = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'org/repo',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_OUTPUT: join(directory, 'output'),
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    RUNNER_TEMP: directory,
    'INPUT_GITHUB-TOKEN': 'gh-secret',
    'INPUT_OPENAI-API-TOKEN': 'ai-secret',
    'INPUT_PROJECT-NUMBER': '17',
    ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value]))
  };
  const calls = { logs: [], engines: [], checkpoints: [] };
  const dependencies = {
    log: (line) => calls.logs.push(line),
    runEngine: async (config, runtime) => {
      calls.engines.push({ config, runtime });
      return { processed: 2, deferred: 1, failed: 0, humanReview: 1, backfillRemaining: true, usage: [{ model: 'gpt-6-luna', input_tokens: 17, output_tokens: 4 }], diagnostics: [{ number: 9, stage: 'classify', reason: 'Operation failed' }] };
    },
    GitHub: class { constructor(config) { this.config = config; } },
    createClassifier: (config) => ({ config }),
    now: () => Date.parse('2026-01-02T03:04:05.000Z')
  };
  return { directory, env, calls, dependencies };
}

test('reads hyphenated GitHub inputs and invokes engine with parsed context', async () => {
  const context = await setup({ inputs: { MODE: 'process', 'ITEM-NUMBER': '42', 'DRY-RUN': 'true', RECLASSIFY: 'false' }, event: { issue: { number: 42 } } });
  try {
    const result = await runAction(context.env, context.dependencies);
    assert.equal(result.processed, 2);
    const { config, runtime } = context.calls.engines[0];
    assert.equal(config.repository, 'org/repo');
    assert.equal(config.projectNumber, 17);
    assert.equal(config.mode, 'process');
    assert.equal(config.itemNumber, 42);
    assert.equal(config.dryRun, true);
    assert.equal(config.reclassify, false);
    assert.deepEqual(config.event, { issue: { number: 42 } });
    assert.equal(runtime.github.config.token, 'gh-secret');
    assert.equal(context.calls.logs.filter((line) => line.startsWith('::add-mask::')).length, 2);
    assert.ok(context.calls.logs.every((line) => !line.includes('gh-secret') || line === '::add-mask::gh-secret'));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('requires credentials according to mode and validates strict inputs', async () => {
  const invalids = [
    [{ 'PROJECT-NUMBER': '0' }, 'project-number'],
    [{ 'ITEM-NUMBER': '-1' }, 'item-number'],
    [{ MODE: 'unknown' }, 'mode'],
    [{ 'DRY-RUN': 'yes' }, 'dry-run'],
    [{ 'RECLASSIFY': 'TRUE' }, 'reclassify'],
    [{ 'GITHUB-TOKEN': '' }, 'github-token'],
    [{ 'OPENAI-API-TOKEN': '' }, 'openai-api-token']
  ];
  for (const [inputs, field] of invalids) {
    const context = await setup({ inputs });
    try { await assert.rejects(runAction(context.env, context.dependencies), new RegExp(field)); }
    finally { await rm(context.directory, { recursive: true, force: true }); }
  }
});

test('enroll permits absent OpenAI token; backfill requires workflow dispatch', async () => {
  const enroll = await setup({ inputs: { MODE: 'enroll', 'OPENAI-API-TOKEN': '' } });
  try {
    await runAction(enroll.env, enroll.dependencies);
    await assert.rejects(enroll.calls.engines[0].runtime.classify(), /Classifier called during enroll mode/);
  } finally { await rm(enroll.directory, { recursive: true, force: true }); }
  const backfill = await setup({ inputs: { MODE: 'backfill' }, eventName: 'schedule' });
  try { await assert.rejects(runAction(backfill.env, backfill.dependencies), /workflow_dispatch/); }
  finally { await rm(backfill.directory, { recursive: true, force: true }); }
});

test('loads absent checkpoint as null and atomically saves checkpoint', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try {
    const checkpointPath = join(context.directory, 'nested', 'state.json');
    context.env['INPUT_CHECKPOINT-PATH'] = checkpointPath;
    await runAction(context.env, context.dependencies);
    const runtime = context.calls.engines[0].runtime;
    assert.equal(runtime.checkpoint, null);
    await runtime.saveCheckpoint({ version: 1, page: 2 });
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { version: 1, page: 2 });
    assert.deepEqual(await readdir(join(context.directory, 'nested')), ['state.json']);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('rejects malformed and oversized checkpoints', async () => {
  for (const contents of ['{bad', 'x'.repeat(1024 * 1024 + 1)]) {
    const context = await setup({ inputs: { MODE: 'enroll' } });
    try {
      const checkpointPath = join(context.directory, 'checkpoint.json');
      await import('node:fs/promises').then(({ writeFile }) => writeFile(checkpointPath, contents));
      context.env['INPUT_CHECKPOINT-PATH'] = checkpointPath;
      await assert.rejects(runAction(context.env, context.dependencies), /checkpoint/i);
    } finally { await rm(context.directory, { recursive: true, force: true }); }
  }
});

test('writes workflow outputs and summary from engine result', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try {
    await runAction(context.env, context.dependencies);
    const output = await readFile(context.env.GITHUB_OUTPUT, 'utf8');
    assert.match(output, /processed=2/);
    assert.match(output, /backfill-remaining=true/);
    assert.doesNotMatch(output, /checkpoint-path=/);
    const summary = await readFile(context.env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.match(summary, /Human review: 1/);
    assert.match(summary, /gpt-6-luna/);
    assert.match(summary, /\| gpt-6-luna \| 1 \| 17 \| 4 \|/);
    assert.match(summary, /Issue #9.*classify.*Operation failed/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('rejects malformed event data, missing context, and unsafe checkpoint paths', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(context.env.GITHUB_EVENT_PATH, '{'));
    await assert.rejects(runAction(context.env, context.dependencies), /event JSON is malformed/);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(context.env.GITHUB_EVENT_PATH, '{}'));
    context.env['INPUT_CHECKPOINT-PATH'] = 'unsafe\nname';
    await assert.rejects(runAction(context.env, context.dependencies), /cannot contain line breaks/);
    delete context.env.GITHUB_EVENT_PATH;
    await assert.rejects(runAction(context.env, context.dependencies), /GITHUB_EVENT_PATH/);
    context.env.GITHUB_EVENT_PATH = join(context.directory, 'event.json');
    delete context.env.GITHUB_EVENT_NAME;
    await assert.rejects(runAction(context.env, context.dependencies), /GITHUB_EVENT_NAME/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('accepts an already authorized active backfill checkpoint on schedule', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' }, eventName: 'schedule' });
  try {
    context.env.INPUT_MODE = 'backfill';
    const checkpointPath = join(context.directory, 'checkpoint.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(checkpointPath, JSON.stringify({ version: 1, repository: 'org/repo', projectNumber: 17, authorizedAt: '2026-01-02T03:04:05.000Z', source: 'workflow_dispatch', page: 1, offset: 0, active: true })));
    context.env['INPUT_CHECKPOINT-PATH'] = checkpointPath;
    await runAction(context.env, context.dependencies);
    assert.equal(context.calls.engines[0].runtime.checkpoint.active, true);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('rejects unsafe non-positive and non-integer number inputs and repository form', async () => {
  for (const [key, value] of [['INPUT_PROJECT-NUMBER', '1.1'], ['INPUT_ITEM-NUMBER', '9007199254740992']]) {
    const context = await setup({ inputs: { MODE: 'enroll' } });
    try { context.env[key] = value; await assert.rejects(runAction(context.env, context.dependencies), new RegExp(key.includes('PROJECT') ? 'project-number' : 'item-number')); }
    finally { await rm(context.directory, { recursive: true, force: true }); }
  }
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try { context.env.GITHUB_REPOSITORY = 'bad'; await assert.rejects(runAction(context.env, context.dependencies), /org\/repo/); }
  finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('escapes workflow mask protocol characters in credential values', async () => {
  const context = await setup({ inputs: { MODE: 'enroll', 'GITHUB-TOKEN': 'g%\r\nh', 'OPENAI-API-TOKEN': '' } });
  try {
    await runAction(context.env, context.dependencies);
    assert.ok(context.calls.logs.includes('::add-mask::g%25%0D%0Ah'));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('reports atomic checkpoint write failures', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try {
    await assert.rejects(runAction(context.env, {
      ...context.dependencies,
      runEngine: async (_config, adapter) => { await adapter.saveCheckpoint({ ok: true }); return { processed: 0, deferred: 0, failed: 0, humanReview: 0, backfillRemaining: 0 }; },
      fs: { mkdir: async () => {}, writeFile: async () => { throw new Error('disk failure'); } }
    }), /Could not save checkpoint: disk failure/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('covers classifier configuration and Date clock normalization', async () => {
  const context = await setup({ inputs: { MODE: 'process' } });
  context.dependencies.now = () => new Date('2026-01-02T03:04:05.000Z');
  let classifierConfig;
  context.dependencies.createClassifier = (value) => { classifierConfig = value; return async () => null; };
  try {
    await runAction(context.env, context.dependencies);
    assert.deepEqual(classifierConfig, { token: 'ai-secret' });
    assert.equal(typeof context.calls.engines[0].runtime.now(), 'object');
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('bounds checkpoint bytes even if a file grows after stat', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try {
    context.dependencies.fs = {
      stat: async () => ({ size: 1 }),
      readFile: async (path) => path === context.env.GITHUB_EVENT_PATH ? JSON.stringify({}) : 'x'.repeat(1024 * 1024 + 1)
    };
    await assert.rejects(runAction(context.env, context.dependencies), /size limit/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('rejects multiline engine output and exercises empty runtime-temp fallback', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try {
    context.env.RUNNER_TEMP = '';
    context.dependencies.runEngine = async () => ({ processed: '1\nother', deferred: 0, failed: 0, humanReview: 0, backfillRemaining: false });
    await assert.rejects(runAction(context.env, context.dependencies), /Invalid engine result counts/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('uses built-in classifier factory and empty-repository fallback branches', async () => {
  const context = await setup({ inputs: { MODE: 'process' } });
  try {
    delete context.env.GITHUB_REPOSITORY;
    await assert.rejects(runAction(context.env, context.dependencies), /org\/repo/);
    context.env.GITHUB_REPOSITORY = 'org/repo';
    context.dependencies.createClassifier = undefined;
    await runAction(context.env, context.dependencies);
    assert.equal(typeof context.calls.engines[0].runtime.classify, 'function');
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('dry run ignores checkpoint saves and does not advertise an existing checkpoint', async () => {
  const context = await setup({ inputs: { MODE: 'backfill', 'DRY-RUN': 'true' }, eventName: 'workflow_dispatch' });
  const path = join(context.directory, 'checkpoint.json');
  const original = JSON.stringify({ version: 1, repository: 'org/repo', projectNumber: 17, authorizedAt: '2026-01-02T03:04:05.000Z', source: 'workflow_dispatch', page: 1, offset: 0, active: true });
  try {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, original));
    context.env['INPUT_CHECKPOINT-PATH'] = path;
    context.dependencies.runEngine = async (_config, runtime) => {
      await runtime.saveCheckpoint({ ...runtime.checkpoint, page: 88 });
      return { processed: 0, deferred: 0, failed: 0, humanReview: 0, backfillRemaining: true, checkpoint: { ...runtime.checkpoint, page: 88 }, usage: [], diagnostics: [] };
    };
    await runAction(context.env, context.dependencies);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.doesNotMatch(await readFile(context.env.GITHUB_OUTPUT, 'utf8'), /checkpoint-path=/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('writes and advertises a persisted manual checkpoint', async () => {
  const context = await setup({ inputs: { MODE: 'backfill' }, eventName: 'workflow_dispatch' });
  const path = join(context.directory, 'resume.json');
  try {
    context.env['INPUT_CHECKPOINT-PATH'] = path;
    context.dependencies.runEngine = async (_config, runtime) => {
      const checkpoint = { version: 1, repository: 'org/repo', projectNumber: 17, authorizedAt: '2026-01-02T03:04:05.000Z', source: 'workflow_dispatch', page: 1, offset: 1, active: true };
      await runtime.saveCheckpoint(checkpoint);
      return { processed: 0, deferred: 1, failed: 0, humanReview: 0, backfillRemaining: true, checkpoint, usage: [], diagnostics: [] };
    };
    await runAction(context.env, context.dependencies);
    assert.ok((await readFile(context.env.GITHUB_OUTPUT, 'utf8')).includes(`checkpoint-path=${path}`));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('publishes failure counts and summary before rejecting engine failures', async () => {
  const context = await setup({ inputs: { MODE: 'process' } });
  try {
    context.dependencies.runEngine = async () => ({ processed: 1, deferred: 0, failed: 2, humanReview: 0, backfillRemaining: false, usage: [], diagnostics: [] });
    await assert.rejects(runAction(context.env, context.dependencies), /2 item failures/);
    assert.match(await readFile(context.env.GITHUB_OUTPUT, 'utf8'), /failed=2/);
    assert.match(await readFile(context.env.GITHUB_STEP_SUMMARY, 'utf8'), /Failed: 2/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('summary limits and sanitizes usage and diagnostic rows', async () => {
  const context = await setup({ inputs: { MODE: 'enroll' } });
  try {
    context.dependencies.runEngine = async () => ({ processed: 0, deferred: 0, failed: 0, humanReview: 1, backfillRemaining: false,
      usage: [{ model: 'gpt-6-luna', input_tokens: 4, output_tokens: 3 }, { model: 'other-model', input_tokens: 99, output_tokens: 99 }, { model: 'gpt-6.1-terra', input_tokens: -1, output_tokens: 2 }],
      diagnostics: [{ number: 4, stage: 'classify', reason: 'Operation failed' }, { number: 'bad', stage: 'stage 4', reason: 'raw error' }] });
    await runAction(context.env, context.dependencies);
    const summary = await readFile(context.env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.match(summary, /gpt-6-luna/);
    assert.doesNotMatch(summary, /other-model|::warning::|raw error/);
    assert.match(summary, /\| gpt-6-luna \| 1 \| 4 \| 3 \|/);
    assert.match(summary, /Issue #4 \(classify\): Operation failed/);
    assert.match(summary, /Diagnostics \(1\)/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('does not advertise a valid-looking but unrelated existing checkpoint', async () => {
  const context = await setup({ inputs: { MODE: 'process' } });
  const path = join(context.directory, 'checkpoint.json');
  try {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify({ version: 1, repository: 'elsewhere/repo', projectNumber: 17, source: 'workflow_dispatch', active: false, authorizedAt: '2026-01-02T03:04:05.000Z', page: 1, offset: 0 })));
    context.env['INPUT_CHECKPOINT-PATH'] = path;
    context.dependencies.runEngine = async () => ({ processed: 0, deferred: 0, failed: 0, humanReview: 0, backfillRemaining: false, checkpoint: null, usage: [], diagnostics: [] });
    await runAction(context.env, context.dependencies);
    assert.doesNotMatch(await readFile(context.env.GITHUB_OUTPUT, 'utf8'), /checkpoint-path=/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('preserves a restored checkpoint path only when result matches the existing file', async () => {
  const context = await setup({ inputs: { MODE: 'process' }, eventName: 'schedule' });
  const path = join(context.directory, 'checkpoint.json');
  const checkpoint = { version: 1, repository: 'org/repo', projectNumber: 17, source: 'workflow_dispatch', active: false, authorizedAt: '2026-01-02T03:04:05.000Z', page: 2, offset: 0, queueCursor: null, queuePending: [] };
  try {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify(checkpoint)));
    context.env['INPUT_CHECKPOINT-PATH'] = path;
    context.dependencies.runEngine = async () => ({ processed: 0, deferred: 0, failed: 0, humanReview: 0, backfillRemaining: false, checkpoint, usage: [], diagnostics: [] });
    await runAction(context.env, context.dependencies);
    assert.ok((await readFile(context.env.GITHUB_OUTPUT, 'utf8')).includes(`checkpoint-path=${path}`));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('summarizes an existing queue cursor checkpoint and tolerates absent report arrays/files', async () => {
  const context = await setup({ inputs: { MODE: 'process' } });
  const path = join(context.directory, 'queue.json');
  try {
    context.env['INPUT_CHECKPOINT-PATH'] = path;
    delete context.env.GITHUB_OUTPUT;
    context.dependencies.runEngine = async (_config, runtime) => {
      const checkpoint = { version: 1, repository: 'org/repo', projectNumber: 17, queueCursor: 'cursor-1', queuePending: [4] };
      await runtime.saveCheckpoint(checkpoint);
      return { processed: 0, deferred: 0, failed: 0, humanReview: 0, backfillRemaining: false, checkpoint };
    };
    await runAction(context.env, context.dependencies);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).queuePending, [4]);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('rejects malformed manual result cursor and bounds model usage totals', async () => {
  const context = await setup({ inputs: { MODE: 'process' } });
  const path = join(context.directory, 'resume.json');
  try {
    context.env['INPUT_CHECKPOINT-PATH'] = path;
    context.dependencies.runEngine = async (_config, runtime) => {
      const checkpoint = { version: 1, repository: 'org/repo', projectNumber: 17, source: 'workflow_dispatch', active: false, authorizedAt: '2026-01-02T03:04:05.000Z', page: 1, offset: -1 };
      await runtime.saveCheckpoint(checkpoint);
      return { processed: 0, deferred: 0, failed: 0, humanReview: 0, backfillRemaining: false, checkpoint,
        usage: [{ model: 'gpt-6-luna', input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, { model: 'gpt-6-luna', input_tokens: 1, output_tokens: 1 }, null] };
    };
    await runAction(context.env, context.dependencies);
    assert.doesNotMatch(await readFile(context.env.GITHUB_OUTPUT, 'utf8'), /checkpoint-path=/);
    const summary = await readFile(context.env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.match(summary, /Diagnostics \(0\)/);
    assert.match(summary, /\| gpt-6-luna \| 1 \| 9007199254740991 \| 1 \|/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('checkpoint mode discovers artifacts early without reading checkpoint files or constructing triage clients', async () => {
  const context = await setup({ inputs: { MODE: 'checkpoint', 'OPENAI-API-TOKEN': '' } });
  let seen;
  try {
    context.env.GITHUB_WORKFLOW_REF = 'org/repo/.github/workflows/triage.yml@main';
    await import('node:fs/promises').then(({ writeFile }) => writeFile(context.env.GITHUB_EVENT_PATH, JSON.stringify({ repository: { id: 21, default_branch: 'main' } })));
    context.dependencies.fs = { stat: async () => { throw new Error('checkpoint file should not be loaded'); } };
    context.dependencies.discoverCheckpoint = async (args) => { seen = args; return { artifactId: '12', runId: '34' }; };
    context.dependencies.GitHub = class { constructor() { throw new Error('GitHub adapter should not be constructed'); } };
    context.dependencies.createClassifier = () => { throw new Error('classifier should not be constructed'); };
    context.dependencies.runEngine = async () => { throw new Error('engine should not run'); };
    assert.deepEqual(await runAction(context.env, context.dependencies), { artifactId: '12', runId: '34' });
    assert.deepEqual(seen, {
      token: 'gh-secret', repository: 'org/repo', workflowRef: context.env.GITHUB_WORKFLOW_REF,
      defaultBranch: 'main', repositoryId: 21, now: context.dependencies.now
    });
    const outputs = await readFile(context.env.GITHUB_OUTPUT, 'utf8');
    assert.match(outputs, /processed=0/);
    assert.match(outputs, /checkpoint-artifact-id=12/);
    assert.match(outputs, /checkpoint-run-id=34/);
    assert.doesNotMatch(outputs, /checkpoint-path=/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('checkpoint mode writes empty discovery outputs and rejects malformed adapter IDs', async () => {
  const context = await setup({ inputs: { MODE: 'checkpoint', 'OPENAI-API-TOKEN': '' } });
  try {
    context.dependencies.discoverCheckpoint = async () => ({ artifactId: null, runId: null });
    await runAction(context.env, context.dependencies);
    assert.ok((await readFile(context.env.GITHUB_OUTPUT, 'utf8')).includes('checkpoint-artifact-id=\ncheckpoint-run-id=\n'));
    context.dependencies.discoverCheckpoint = async () => ({ artifactId: 'bad', runId: '2' });
    await assert.rejects(runAction(context.env, context.dependencies), /Invalid checkpoint discovery result/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test('checkpoint mode defaults to built-in discovery with injected bounded request', async () => {
  const context = await setup({ inputs: { MODE: 'checkpoint', 'OPENAI-API-TOKEN': '' } });
  const paths = [];
  try {
    context.env.GITHUB_WORKFLOW_REF = 'org/repo/.github/workflows/triage.yml@main';
    await import('node:fs/promises').then(({ writeFile }) => writeFile(context.env.GITHUB_EVENT_PATH, JSON.stringify({ repository: { id: 21, default_branch: 'main' } })));
    context.dependencies.discoverCheckpoint = undefined;
    context.dependencies.now = undefined;
    context.dependencies.checkpointDependencies = { request: async (_method, path) => {
      paths.push(path);
      return path.includes('/workflows/') ? { id: 41 } : { artifacts: [] };
    } };
    assert.deepEqual(await runAction(context.env, context.dependencies), { artifactId: null, runId: null });
    assert.equal(paths.length, 2);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});
