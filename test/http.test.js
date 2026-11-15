import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '../src/http.js';

test('HTTP authenticates JSON and returns decoded data', async () => {
  const request = createHttp({ token: 'secret', origin: 'https://api.github.com', fetch: async (url, options) => {
    assert.equal(url, 'https://api.github.com/test');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(options.body, '{"x":1}');
    assert.ok(options.signal);
    return new Response('{"ok":true}');
  }});
  assert.deepEqual(await request('POST', '/test', { x: 1 }), { ok: true });
});

test('HTTP handles empty responses and rejects invalid JSON without echoing it', async () => {
  const empty = createHttp({ token: 'x', origin: 'https://api.openai.com', fetch: async (_url, options) => {
    assert.equal(options.body, undefined);
    assert.equal(options.headers['X-GitHub-Api-Version'], undefined);
    assert.equal(options.headers.Accept, 'application/json');
    return new Response(null, { status: 204 });
  }});
  assert.equal(await empty('GET', '/empty'), null);
  const bad = createHttp({ token: 'x', origin: 'https://api.openai.com', fetch: async () => new Response('private') });
  await assert.rejects(bad('GET', '/bad'), { message: 'Invalid JSON response from api.openai.com' });
});

test('HTTP only accepts relative paths on a trusted HTTPS origin', async () => {
  for (const origin of ['http://api.github.com', 'https://evil.example', 'https://api.github.com/other']) {
    assert.throws(() => createHttp({ token: 'x', origin }), /Unsupported API origin/);
  }
  const r = createHttp({ token: 'x', origin: 'https://api.github.com' });
  for (const path of ['https://evil.example', '//evil.example', '/\\evil', '/a\n']) {
    await assert.rejects(r('GET', path), /Invalid API path/);
  }
});

test('HTTP retries safe transport, 429, and server failures with bounded backoff', async () => {
  const sleeps = [];
  let calls = 0;
  const r = createHttp({ token: 'hidden', origin: 'https://api.github.com', sleep: async ms => sleeps.push(ms), fetch: async () => {
    calls++;
    if (calls === 1) throw new Error('hidden raw transport text');
    if (calls === 2) return new Response('hidden', { status: 429, headers: { 'Retry-After': '300' } });
    return new Response('{}');
  }});
  assert.deepEqual(await r('GET', '/safe'), {});
  assert.deepEqual(sleeps, [1000, 30000]);
  assert.equal(calls, 3);
  const server = createHttp({ token: 'x', origin: 'https://api.openai.com', sleep: async () => {}, fetch: async () => new Response('', { status: 503 }) });
  await assert.rejects(server('POST', '/v1/responses', {}), { message: 'HTTP 503 from api.openai.com', status: 503 });
});

test('HTTP handles date and invalid retry hints and GitHub rate limits', async () => {
  for (const [header, expected] of [['Sun, 15 Nov 2026 00:00:02 GMT', 2000], ['nonsense', 1000]]) {
    let count = 0;
    const sleep = [];
    const r = createHttp({ token: 'x', origin: 'https://api.github.com', now: () => Date.parse('2026-11-15T00:00:00Z'), sleep: async ms => sleep.push(ms), fetch: async () => ++count === 1 ? new Response('', { status: 403, headers: { 'Retry-After': header } }) : new Response('{}') });
    await r('GET', '/rate');
    assert.deepEqual(sleep, [expected]);
  }
});

test('HTTP never replays GitHub mutations or leaks response and transport content', async () => {
  for (const [method, path, body] of [['POST', '/graphql', { query: 'mutation { change }' }], ['PATCH', '/issues/1', {}], ['POST', '/comments', {}]]) {
    let count = 0;
    const r = createHttp({ token: 'secret', origin: 'https://api.github.com', fetch: async () => { count++; throw new Error('secret'); } });
    await assert.rejects(r(method, path, body), { message: 'Network request failed for api.github.com' });
    assert.equal(count, 1);
  }
  const r = createHttp({ token: 'x', origin: 'https://api.github.com', fetch: async () => new Response('secret', { status: 401 }) });
  await assert.rejects(r('GET', '/denied'), { message: 'HTTP 401 from api.github.com', status: 401 });
});

test('HTTP retries GraphQL read queries but stops after three failed network attempts', async () => {
  let count = 0;
  const r = createHttp({ token: 'x', origin: 'https://api.github.com', sleep: async () => {}, fetch: async () => { count++; throw new Error('private'); } });
  await assert.rejects(r('POST', '/graphql', { query: 'query { viewer { login } }' }), /Network request failed/);
  assert.equal(count, 3);
});

test('HTTP default timer and empty rate-limit hints use bounded fallback delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const r = createHttp({ token: 'x', origin: 'https://api.github.com', fetch: async () => ++count === 1 ? new Response('', { status: 500, headers: { 'Retry-After': '' } }) : new Response('{}') });
  const pending = r('GET', '/safe');
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.deepEqual(await pending, {});
  assert.equal(count, 2);
});

test('HTTP shares the processing deadline across requests and never sleeps past it', async () => {
  let time=100;
  let requests=0;
  const r=createHttp({token:'x',origin:'https://api.github.com',now:()=>time,deadline:()=>200,fetch:async(_url,options)=>{
    requests++;
    assert.ok(options.signal);
    return new Response('',{status:429,headers:{'Retry-After':'30'}});
  },sleep:async()=>assert.fail('must not sleep beyond deadline')});
  await assert.rejects(r('GET','/rate'),/Processing deadline exceeded/);
  assert.equal(requests,1);
  time=200;
  await assert.rejects(r('GET','/expired'),/Processing deadline exceeded/);
  assert.equal(requests,1);
  time=100;
  const network=createHttp({token:'x',origin:'https://api.github.com',now:()=>time,deadline:()=>200,fetch:async()=>{throw new Error('private')},sleep:async()=>assert.fail('deadline')});
  await assert.rejects(network('GET','/network'),/Processing deadline exceeded/);
});
