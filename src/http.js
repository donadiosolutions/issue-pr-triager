const ORIGINS = new Set(['https://api.github.com', 'https://api.openai.com']);

export function createHttp({ token, origin, fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, deadline = () => Infinity }) {
  if (!ORIGINS.has(origin)) throw new Error('Unsupported API origin');
  const host = new URL(origin).host;
  return async function request(method, path, body = undefined) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/u.test(path)) throw new Error('Invalid API path');
    const retryable = method === 'GET' || origin === 'https://api.openai.com' || (path === '/graphql' && /^\s*query\b/u.test(body?.query));
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = Math.ceil(deadline() - now());
      if (remaining <= 0) throw new Error('Processing deadline exceeded');
      let response;
      try {
        const headers = { Authorization: `Bearer ${token}`, Accept: origin === 'https://api.github.com' ? 'application/vnd.github+json' : 'application/json', 'Content-Type': 'application/json' };
        if (origin === 'https://api.github.com') headers['X-GitHub-Api-Version'] = '2026-03-10';
        response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(30000, remaining)), redirect: 'error' });
      } catch {
        failure = new Error(`Network request failed for ${host}`);
        if (!retryable) throw failure;
        if (attempt < 2) {
          const delay = 1000 * (attempt + 1);
          if (delay >= deadline() - now()) throw new Error('Processing deadline exceeded');
          await sleep(delay);
        }
        continue;
      }
      if (response.ok) {
        if (response.status === 204) return null;
        try { return await response.json(); }
        catch { throw new Error(`Invalid JSON response from ${host}`); }
      }
      const hint = response.headers.get('Retry-After');
      if (retryable && attempt < 2 && (response.status === 429 || response.status >= 500 || (response.status === 403 && hint !== null))) {
        const seconds = Number(hint);
        const delay = hint !== null && hint.trim() !== '' && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(hint) - now();
        const wait = Number.isFinite(delay) ? Math.max(0, Math.min(30000, delay)) : 1000 * (attempt + 1);
        if (wait >= deadline() - now()) throw new Error('Processing deadline exceeded');
        await sleep(wait);
        continue;
      }
      throw Object.assign(new Error(`HTTP ${response.status} from ${host}`), { status: response.status });
    }
    throw failure;
  };
}
