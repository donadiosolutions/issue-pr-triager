import { createHttp } from './http.js';

const ARTIFACT_NAME = 'issue-pr-triager-checkpoint';
const MAX_ARTIFACTS = 100;
const DEADLINE_MS = 60000;
const ALLOWED_EVENTS = new Set(['issues', 'pull_request_target', 'schedule', 'workflow_dispatch']);

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function workflowFile(repository, workflowRef) {
  const prefix = `${repository}/.github/workflows/`;
  if (typeof workflowRef !== 'string' || !workflowRef.startsWith(prefix)) throw new Error('Invalid caller workflow ref.');
  const suffix = workflowRef.slice(prefix.length);
  const separator = suffix.lastIndexOf('@');
  if (separator <= 0 || separator === suffix.length - 1) throw new Error('Invalid caller workflow ref.');
  const filename = suffix.slice(0, separator);
  if (!/^[^/@]+$/u.test(filename)) throw new Error('Invalid caller workflow ref.');
  return filename;
}

export async function discoverCheckpoint({ token, repository, workflowRef, defaultBranch, repositoryId, request, fetch, sleep, now = Date.now }) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('Checkpoint discovery requires a GitHub token.');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Invalid repository.');
  const filename = workflowFile(repository, workflowRef);
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0 || /[\r\n]/u.test(defaultBranch)) throw new Error('Invalid repository default branch.');
  if (!positiveId(repositoryId)) throw new Error('Invalid repository ID.')
  const started = now();
  const deadlineAt = started + DEADLINE_MS;
  const call = request ?? createHttp({ token, origin: 'https://api.github.com', fetch, sleep, now, deadline: () => deadlineAt });
  const get = async (path) => {
    if (now() >= deadlineAt) throw new Error('Checkpoint discovery deadline exceeded.');
    return call('GET', path);
  };

  const workflow = await get(`/repos/${repository}/actions/workflows/${encodeURIComponent(filename)}`);
  if (!workflow || !positiveId(workflow.id)) throw new Error('Invalid caller workflow response.');
  const listed = await get(`/repos/${repository}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=${MAX_ARTIFACTS}`);
  if (!listed || !Array.isArray(listed.artifacts) || listed.artifacts.length > MAX_ARTIFACTS) throw new Error('Invalid checkpoint artifact response.');

  const candidates = listed.artifacts.filter((artifact) => artifact?.expired === false &&
    artifact.workflow_run?.head_branch === defaultBranch &&
    artifact.workflow_run.head_repository_id === repositoryId);
  for (const artifact of candidates) {
    if (!positiveId(artifact.id) || !positiveId(artifact.workflow_run.id)) throw new Error('Invalid checkpoint artifact identifiers.');
    if (!Number.isFinite(Date.parse(artifact.created_at))) throw new Error('Invalid checkpoint artifact timestamp.');
  }
  candidates.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  for (const artifact of candidates) {
    const run = await get(`/repos/${repository}/actions/runs/${artifact.workflow_run.id}`);
    if (!run || !positiveId(run.id) || !positiveId(run.workflow_id)) throw new Error('Invalid checkpoint workflow run response.');
    if (run.id === artifact.workflow_run.id && run.workflow_id === workflow.id &&
      run.head_branch === defaultBranch && run.head_repository?.id === repositoryId && ALLOWED_EVENTS.has(run.event)) {
      return { artifactId: String(artifact.id), runId: String(run.id) };
    }
  }
  return { artifactId: null, runId: null };
}
