import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCheckpoint } from '../src/checkpoint.js';

const context = {
  token: 'read-token', repository: 'org/repo', workflowRef: 'org/repo/.github/workflows/triage.yml@main',
  defaultBranch: 'main', repositoryId: 9
};

function makeRequest(routes) {
  const calls = [];
  return {
    calls,
    request: async (method, path) => {
      calls.push({ method, path });
      if (!(path in routes)) throw new Error(`Unexpected path ${path}`);
      return routes[path];
    }
  };
}

const artifactsPath = '/repos/org/repo/actions/artifacts?name=issue-pr-triager-checkpoint&per_page=100';
const workflowPath = '/repos/org/repo/actions/workflows/triage.yml';
const workflow = { id: 41 };
const artifact = (id, runId, overrides = {}) => ({ id, expired: false, created_at: `2026-11-${String(id).padStart(2, '0')}T00:00:00Z`, workflow_run: { id: runId, head_branch: 'main', head_repository_id: 9 }, ...overrides });

 test('discovers newest unexpired default-branch artifact from the exact workflow', async () => {
  const routes = makeRequest({
    [workflowPath]: workflow,
    [artifactsPath]: { artifacts: [
      artifact(11, 101, { created_at: '2026-11-11T00:00:00Z' }),
      artifact(12, 102, { created_at: '2026-11-12T00:00:00Z' }),
      artifact(13, 103, { expired: true, created_at: '2026-11-13T00:00:00Z' }),
      artifact(14, 104, { created_at: '2026-11-14T00:00:00Z', workflow_run: { id: 104, head_branch: 'feature', head_repository_id: 9 } }),
      artifact(15, 105, { created_at: '2026-11-15T00:00:00Z', workflow_run: { id: 105, head_branch: 'main', head_repository_id: 10 } })
    ] },
    '/repos/org/repo/actions/runs/102': { id: 102, workflow_id: 41, event: 'schedule', head_branch: 'main', head_repository: { id: 9 } }
  });
  const result = await discoverCheckpoint({ ...context, request: routes.request, now: () => 1000 });
  assert.deepEqual(result, { artifactId: '12', runId: '102' });
  assert.deepEqual(routes.calls.map((call) => call.path), [workflowPath, artifactsPath, '/repos/org/repo/actions/runs/102']);
  assert.ok(routes.calls.every((call) => call.method === 'GET'));
});

test('skips wrong workflow runs and selects next newest matching run', async () => {
  const routes = makeRequest({
    [workflowPath]: workflow,
    [artifactsPath]: { artifacts: [artifact(8, 88), artifact(7, 77)] },
    '/repos/org/repo/actions/runs/88': { id: 88, workflow_id: 42, event: 'schedule', head_branch: 'main', head_repository: { id: 9 } },
    '/repos/org/repo/actions/runs/77': { id: 77, workflow_id: 41, event: 'workflow_dispatch', head_branch: 'main', head_repository: { id: 9 } }
  });
  assert.deepEqual(await discoverCheckpoint({ ...context, request: routes.request }), { artifactId: '7', runId: '77' });
});

test('returns empty IDs when there is no matching artifact', async () => {
  const routes = makeRequest({ [workflowPath]: workflow, [artifactsPath]: { artifacts: [] } });
  assert.deepEqual(await discoverCheckpoint({ ...context, request: routes.request }), { artifactId: null, runId: null });
});

test('validates workflow reference, identifiers and response shapes safely', async () => {
  for (const workflowRef of ['foreign/repo/.github/workflows/a.yml@main', 'org/repo/.github/workflows/a/b.yml@main', 'org/repo/.github/workflows/a.yml']) {
    await assert.rejects(discoverCheckpoint({ ...context, workflowRef, request: async () => assert.fail('no request expected') }), /workflow ref/i);
  }
  await assert.rejects(discoverCheckpoint({ ...context, request: makeRequest({ [workflowPath]: { id: 0 } }).request }), /workflow/i);
  await assert.rejects(discoverCheckpoint({ ...context, request: makeRequest({ [workflowPath]: workflow, [artifactsPath]: {} }).request }), /artifact/i);
  await assert.rejects(discoverCheckpoint({ ...context, request: makeRequest({ [workflowPath]: workflow, [artifactsPath]: { artifacts: [artifact(0, 1)] } }).request }), /artifact/i);
});

test('rejects malformed run IDs and stops when the absolute deadline expires', async () => {
  const badRoutes = makeRequest({ [workflowPath]: workflow, [artifactsPath]: { artifacts: [artifact(1, 0)] } });
  await assert.rejects(discoverCheckpoint({ ...context, request: badRoutes.request }), /artifact/i);
  let time = 0;
  let calls = 0;
  const request = async () => { calls++; time = 60001; return workflow; };
  await assert.rejects(discoverCheckpoint({ ...context, request, now: () => time }), /deadline/i);
  assert.equal(calls, 1);
});

test('builds the bounded API transport from fetch and uses caller token', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('triage.yml') ? workflow : { artifacts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await discoverCheckpoint({ ...context, fetch, now: () => 0 });
  assert.deepEqual(result, { artifactId: null, runId: null });
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer read-token' && options.method === 'GET'));
});

test('skips fork-produced artifacts and untrusted pull request head runs before selecting trusted history', async () => {
  const routes = makeRequest({
    [workflowPath]: workflow,
    [artifactsPath]: { artifacts: [artifact(20, 200, { created_at: '2026-11-20T00:00:00Z', workflow_run: { id: 200, head_branch: 'main', head_repository_id: 10 } }), artifact(19, 199, { created_at: '2026-11-19T00:00:00Z' }), artifact(18, 198, { created_at: '2026-11-18T00:00:00Z' })] },
    '/repos/org/repo/actions/runs/199': { id: 199, workflow_id: 41, event: 'pull_request', head_branch: 'main', head_repository: { id: 9 } },
    '/repos/org/repo/actions/runs/198': { id: 198, workflow_id: 41, event: 'issues', head_branch: 'main', head_repository: { id: 9 } }
  });
  assert.deepEqual(await discoverCheckpoint({ ...context, request: routes.request }), { artifactId: '18', runId: '198' });
  assert.ok(!routes.calls.some(({ path }) => path.includes('/runs/200')));
});

test('requires repository identity and accepts only bounded artifact responses', async () => {
  await assert.rejects(discoverCheckpoint({ ...context, repositoryId: undefined, request: async () => assert.fail('no request expected') }), /repository ID/);
  for (const listed of [null, { artifacts: Array(101).fill(artifact(1, 1)) }]) {
    await assert.rejects(discoverCheckpoint({ ...context, request: makeRequest({ [workflowPath]: workflow, [artifactsPath]: listed }).request }), /artifact/i);
  }
});

test('rejects invalid required request context before any API call', async () => {
  const noRequest = async () => assert.fail('no request expected');
  for (const overrides of [
    { token: 7 }, { repository: null }, { defaultBranch: undefined },
    { defaultBranch: 'main\rbranch' }
  ]) {
    await assert.rejects(discoverCheckpoint({ ...context, ...overrides, request: noRequest }));
  }
});

test('rejects invalid timestamps and workflow run metadata', async () => {
  await assert.rejects(discoverCheckpoint({ ...context, request: makeRequest({
    [workflowPath]: workflow, [artifactsPath]: { artifacts: [artifact(1, 1, { created_at: 'bad-time' })] }
  }).request }), /timestamp/i);
  for (const run of [null, { id: 1 }, { id: 1, workflow_id: 0 }]) {
    await assert.rejects(discoverCheckpoint({ ...context, request: makeRequest({
      [workflowPath]: workflow, [artifactsPath]: { artifacts: [artifact(1, 1)] }, '/repos/org/repo/actions/runs/1': run
    }).request }), /workflow run/i);
  }
});
