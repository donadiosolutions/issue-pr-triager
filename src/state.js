import { createHash } from 'node:crypto';

export function newState(config, enrollmentSource) {
  return {version:1,repository:config.repository,projectNumber:config.projectNumber,enrollmentSource,phase:'pending',pass:0,fingerprint:'',ownership:{labels:[]},removedLabels:[],unresolved:[],attempts:0,decision:null,pending:null};
}

export function readState(comments, bot, config) {
  let result = null;
  for (const comment of comments) {
    if (comment.author !== bot) continue;
    const match = comment.body.match(/<!-- issue-pr-triager:v1 (.*?) -->/s);
    if (!match) continue;
    let state;
    try { state = JSON.parse(match[1]); } catch { continue; }
    if (!state || state.version !== 1 || state.repository !== config.repository || state.projectNumber !== config.projectNumber ||
      !['creation','manual'].includes(state.enrollmentSource) || !['pending','complete','review'].includes(state.phase) ||
      !Number.isInteger(state.pass) || state.pass < 0 || state.pass > 2 || typeof state.fingerprint !== 'string' ||
      !state.ownership || Array.isArray(state.ownership) || typeof state.ownership !== 'object' ||
      !Array.isArray(state.ownership.labels) || state.ownership.labels.some(x => typeof x !== 'string') ||
      ['type','priority','effort'].some(key => key in state.ownership && typeof state.ownership[key] !== 'string') ||
      ('parent' in state.ownership && (!Number.isInteger(state.ownership.parent) || state.ownership.parent < 1)) ||
      (state.pending != null && !validPending(state.pending)) ||
      (state.removedLabels !== undefined && (!Array.isArray(state.removedLabels) || state.removedLabels.some(x => typeof x !== 'string'))) ||
      !Array.isArray(state.unresolved) || state.unresolved.some(x => typeof x !== 'string') ||
      !Number.isInteger(state.attempts) || state.attempts < 0) continue;
    state.removedLabels ??= [];
    result = {state,commentId:comment.id};
  }
  return result;
}

function validPending(pending) {
  if (!['labels','type','priority','effort','parent'].includes(pending.field)) return false;
  if (pending.field === 'parent') return Number.isInteger(pending.value) && pending.value > 0;
  if (pending.field === 'labels') return Array.isArray(pending.value) && pending.value.every(x => typeof x === 'string');
  return typeof pending.value === 'string';
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])]));
  return value;
}

export function modelEvidence(item, bot) {
  return {...item,
    body:item.body.replace(/\s*<!-- issue-pr-triager:link -->.*?<!-- \/issue-pr-triager:link -->/gs,''),
    comments:item.comments.filter(c => c.author !== bot || !c.body.includes('<!-- issue-pr-triager:v1 ')),
  };
}

function catalogChoices(choices = []) {
  return choices.filter(x => x.name !== 'triage').map(x => ({name:x.name,description:x.description ?? ''})).sort((a,b) => a.name.localeCompare(b.name));
}

export function fingerprint(item, catalog, ownership, bot, removedLabels = []) {
  const fields = item.kind === 'pr' ? item.projectValues : item;
  const values = {};
  for (const key of ['type','priority','effort']) values[key] = fields[key] === ownership[key] ? null : (fields[key] ?? null);
  const clean = modelEvidence(item,bot);
  const semanticCatalog = {
    labels:catalogChoices(catalog.labels),types:catalogChoices(catalog.types),
    priority:{name:catalog.priority?.name ?? '',description:catalog.priority?.description ?? '',options:catalogChoices(catalog.priority?.options)},
    effort:{name:catalog.effort?.name ?? '',description:catalog.effort?.description ?? '',options:catalogChoices(catalog.effort?.options)},
  };
  const evidence = {
    title:item.title,body:clean.body,kind:item.kind,
    labels:item.labels.filter(x => x !== 'triage' && !ownership.labels?.includes(x)).sort(),removedLabels:[...removedLabels].sort(),...values,
    comments:clean.comments.map(c => ({author:c.author,body:c.body})),
    files:item.files,associations:item.associations.filter(x => x !== ownership.parent),baseBranch:item.baseBranch ?? null,headSha:item.headSha ?? null,
    truncated:item.truncated ?? false,catalog:semanticCatalog,
  };
  return createHash('sha256').update(JSON.stringify(stable(evidence))).digest('hex');
}

export function validQueueCheckpoint(value, config) {
  return Boolean(value && value.version === 1 && value.repository === config.repository && value.projectNumber === config.projectNumber &&
    (value.queueCursor == null || (typeof value.queueCursor === 'string' && value.queueCursor.length <= 1024)) &&
    (value.queuePending === undefined || (Array.isArray(value.queuePending) && value.queuePending.length <= 20 && value.queuePending.every(x => Number.isInteger(x) && x > 0))));
}

export function validCheckpoint(value, config, now) {
  if (!value || value.version !== 1 || value.repository !== config.repository || value.projectNumber !== config.projectNumber ||
    value.source !== 'workflow_dispatch' || value.active !== true || !Number.isInteger(value.page) || value.page < 1 ||
    !Number.isInteger(value.offset) || value.offset < 0) return false;
  const age = now - Date.parse(value.authorizedAt);
  return Number.isFinite(age) && age >= 0 && age <= 30 * 86400000;
}
