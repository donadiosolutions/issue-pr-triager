import { mkdir, readFile, rename, writeFile, appendFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runEngine as defaultRunEngine } from './engine.js';
import { GitHub as DefaultGitHub } from './github.js';
import { createClassifier as defaultCreateClassifier } from './models.js';
import { validCheckpoint, validQueueCheckpoint } from './state.js';

const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const INPUTS = [
  'github-token', 'openai-api-token', 'project-number', 'mode', 'item-number',
  'dry-run', 'reclassify', 'checkpoint-path', 'priority-field-name', 'effort-field-name'
];

function input(env, name) {
  return env[`INPUT_${name.toUpperCase()}`] ?? '';
}

function positiveInteger(value, name, optional = false) {
  if (optional && value === '') return null;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${name}: expected a positive integer.`);
  }
  return Number(value);
}

function booleanInput(value, name) {
  if (value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}: expected exactly true or false.`);
}

function mask(value, log) {
  if (value !== '') log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}

async function loadCheckpoint(path, fs) {
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint exceeds the 1 MiB size limit.');
    const text = await fs.readFile(path, 'utf8');
    if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint exceeds the 1 MiB size limit.');
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('Checkpoint JSON is malformed.');
    throw error;
  }
}

async function saveCheckpoint(path, checkpoint, fs) {
  const stagingPath = `${path}.${randomUUID()}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(stagingPath, `${JSON.stringify(checkpoint)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(stagingPath, path);
  } catch (error) {
    throw new Error(`Could not save checkpoint: ${error.message}`);
  }
}

function escapeSummaryText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(':', '&#58;').replaceAll('|', '\\|').replaceAll('`', "\\`");
}

function modelUsage(usage) {
  const totals = new Map();
  for (const row of Array.isArray(usage) ? usage : []) {
    if (!row || !['gpt-6-luna', 'gpt-6.1-terra'].includes(row.model) ||
      !Number.isSafeInteger(row.input_tokens) || row.input_tokens < 0 ||
      !Number.isSafeInteger(row.output_tokens) || row.output_tokens < 0) continue;
    const total = totals.get(row.model) ?? { input: 0, output: 0, calls: 0 };
    const input = total.input + row.input_tokens;
    const output = total.output + row.output_tokens;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) continue;
    totals.set(row.model, { input, output, calls: total.calls + 1 });
  }
  return [...totals.entries()];
}

function validManualResultCheckpoint(value, config, timestamp) {
  if (!value || value.version !== 1 || value.repository !== config.repository || value.projectNumber !== config.projectNumber ||
    value.source !== 'workflow_dispatch' || typeof value.active !== 'boolean' || !Number.isInteger(value.page) || value.page < 1 ||
    !Number.isInteger(value.offset) || value.offset < 0) return false;
  const age = timestamp - Date.parse(value.authorizedAt);
  return Number.isFinite(age) && age >= 0 && age <= 30 * 86400000;
}

function validResultCheckpoint(value, config, timestamp) {
  return validManualResultCheckpoint(value, config, timestamp) || (Array.isArray(value?.queuePending) && validQueueCheckpoint(value, config));
}

function validCounts(result) {
  return ['processed', 'deferred', 'failed', 'humanReview'].every((key) => Number.isSafeInteger(result[key]) && result[key] >= 0) &&
    typeof result.backfillRemaining === 'boolean';
}

function validDiagnostics(result) {
  return (Array.isArray(result.diagnostics) ? result.diagnostics : [])
    .filter((row) => row && Number.isSafeInteger(row.number) && row.number > 0 &&
      ['read', 'state', 'queue', 'project', 'fields', 'candidates', 'classify', 'refresh', 'catalog', 'apply', 'link'].includes(row.stage) &&
      ['Deadline reached', 'Operation failed'].includes(row.reason))
    .slice(0, 20);
}

async function appendOutputs(env, fs, result, checkpointPath) {
  const lines = [
    `processed=${result.processed}`,
    `deferred=${result.deferred}`,
    `failed=${result.failed}`,
    `human-review=${result.humanReview}`,
    `backfill-remaining=${result.backfillRemaining}`
  ];
  if (checkpointPath) lines.push(`checkpoint-path=${checkpointPath}`);
  if (!validCounts(result)) throw new Error('Invalid engine result counts.');
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '# Issue and PR triage', '',
      `Processed: ${result.processed}`, `Deferred: ${result.deferred}`,
      `Failed: ${result.failed}`, `Human review: ${result.humanReview}`,
      `Backfill remaining: ${result.backfillRemaining}`, '',
      '## Model usage', '',
      '| Model | Calls | Input tokens | Output tokens |',
      '| --- | ---: | ---: | ---: |',
      ...modelUsage(result.usage).map(([model, totals]) => `| ${model} | ${totals.calls} | ${totals.input} | ${totals.output} |`), '',
      `## Diagnostics (${validDiagnostics(result).length})`, ''
    ];
    const diagnostics = validDiagnostics(result);
    for (const row of diagnostics) summary.push(`- Issue #${row.number} (${row.stage}): ${escapeSummaryText(row.reason.slice(0, 240))}`);
    await fs.appendFile(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
}

export async function runAction(env = process.env, dependencies = {}) {
  const fs = { mkdir, readFile, rename, writeFile, appendFile, stat, ...(dependencies.fs ?? {}) };
  const log = dependencies.log ?? ((line) => console.log(line));
  const values = Object.fromEntries(INPUTS.map((name) => [name, input(env, name)]));
  mask(values['github-token'], log);
  mask(values['openai-api-token'], log);
  const repository = env.GITHUB_REPOSITORY ?? '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must be in org/repo form.');
  if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required.');
  if (!env.GITHUB_EVENT_NAME) throw new Error('GITHUB_EVENT_NAME is required.');
  if (!values['github-token']) throw new Error('github-token is required.');
  const projectNumber = positiveInteger(values['project-number'], 'project-number');
  const itemNumber = positiveInteger(values['item-number'], 'item-number', true);
  const mode = values.mode || 'process';
  if (!['enroll', 'process', 'backfill'].includes(mode)) throw new Error('Invalid mode: expected enroll, process, or backfill.');
  const dryRun = booleanInput(values['dry-run'], 'dry-run');
  const reclassify = booleanInput(values.reclassify, 'reclassify');
  if (mode !== 'enroll' && !values['openai-api-token']) throw new Error('openai-api-token is required.');
  const eventText = await fs.readFile(env.GITHUB_EVENT_PATH, 'utf8');
  let event;
  try { event = JSON.parse(eventText); }
  catch { throw new Error('GitHub event JSON is malformed.'); }
  const checkpointPath = values['checkpoint-path'] || join(env.RUNNER_TEMP || process.cwd(), 'issue-pr-triager', 'checkpoint.json');
  if (/[\r\n]/.test(checkpointPath)) throw new Error('checkpoint-path cannot contain line breaks.');
  const checkpoint = await loadCheckpoint(checkpointPath, fs);
  const config = {
    repository, projectNumber, priorityFieldName: values['priority-field-name'] || 'Priority',
    effortFieldName: values['effort-field-name'] || 'Effort', mode, itemNumber,
    dryRun, reclassify, eventName: env.GITHUB_EVENT_NAME, event
  };
  const clock = dependencies.now ?? Date.now;
  const observedTime = clock();
  const timestamp = observedTime instanceof Date ? observedTime.getTime() : observedTime;
  if (mode === 'backfill' && env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && !validCheckpoint(checkpoint, config, timestamp)) {
    throw new Error('backfill requires workflow_dispatch or an authorized active checkpoint.');
  }
  const GitHub = dependencies.GitHub ?? DefaultGitHub;
  const github = new GitHub({ token: values['github-token'], repository, dryRun });
  const createClassifier = dependencies.createClassifier ?? defaultCreateClassifier;
  const classify = mode === 'enroll' ? async () => { throw new Error('Classifier called during enroll mode.'); } : createClassifier({ token: values['openai-api-token'] });
  const engine = dependencies.runEngine ?? defaultRunEngine;
  let savedCheckpoint = null;
  const result = await engine(config, {
    github, classify, now: clock, checkpoint,
    saveCheckpoint: async (value) => {
      if (!dryRun) {
        await saveCheckpoint(checkpointPath, value, fs);
        savedCheckpoint = structuredClone(value);
      }
    }
  });
  const resultCheckpoint = result.checkpoint;
  const outputCheckpointPath = !dryRun && resultCheckpoint && validResultCheckpoint(resultCheckpoint, config, timestamp) &&
    ((savedCheckpoint && JSON.stringify(savedCheckpoint) === JSON.stringify(resultCheckpoint)) ||
      (checkpoint && validResultCheckpoint(checkpoint, config, timestamp) && JSON.stringify(checkpoint) === JSON.stringify(resultCheckpoint) && savedCheckpoint === null)) ? checkpointPath : null;
  await appendOutputs(env, fs, result, outputCheckpointPath);
  if (result.failed > 0) throw new Error(`${result.failed} item failures; inspect the step summary and outputs.`);
  return result;
}
