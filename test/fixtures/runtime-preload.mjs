const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (process.env.INPUT_MODE === 'checkpoint' && init.method !== 'GET') throw new Error('Checkpoint mock allows read-only requests.');
  if (url.pathname === '/graphql') {
    const { query } = JSON.parse(init.body ?? '{}');
    if (query.includes('viewer')) return json({ data: { viewer: { login: 'triager[bot]' } } });
    return json({ data: { organization: { projectV2: { id: 'PVT_1', fields: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  }
  if (url.pathname === '/repos/org/repo') return json({ default_branch: 'main' });
  if (url.pathname === '/repos/org/repo/actions/workflows/triage.yml') return json({ id: 41 });
  if (url.pathname === '/repos/org/repo/actions/artifacts') return json({ artifacts: [] });
  if (url.pathname === '/repos/org/repo/issues/3') return json({ number: 3, node_id: 'I_3', title: 'Sample issue', body: '', state: 'open', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', type: null });
  if (url.pathname === '/orgs/org/issue-fields') return json([
    { id: 1, name: 'Priority', options: [{ id: 11, name: 'High' }] },
    { id: 2, name: 'Effort', options: [{ id: 22, name: 'Small' }] }
  ]);
  if (url.pathname.endsWith('/labels') || url.pathname.endsWith('/comments') || url.pathname.endsWith('/issue-field-values') || url.pathname === '/orgs/org/issue-types') return json([]);
  throw new Error(`Unexpected mocked request: ${url.pathname}`);
};
