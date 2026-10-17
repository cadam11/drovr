import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALL_TIMEOUT_MS, callToolOnce, credentialsPath, deleteCredentials, issuerOf, NotSignedIn, readCredentials, refreshCredentials,
  SignInExpired, toolCaller, writeCredentials, type Credentials, type Http,
} from '../src/hey-http.ts';

const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const ENDPOINT = 'https://hey.drovr.app/mcp';
const creds = (over: Partial<Credentials> = {}): Credentials => ({ access: 'acc1', refresh: 'ref1', expiresAt: new Date(T0 + 3_600_000).toISOString(), issuer: 'https://hey.drovr.app', ...over });

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
/** A fetch that answers from a script in order and records every request; running out of script throws. */
const fakeHttp = (script: Array<{ status: number; body: unknown; headers?: Record<string, string> }>): Http & { seen: Seen[] } => {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    seen.push({ url: String(input), method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') });
    const next = script.shift();
    if (next === undefined) throw new Error(`fakeHttp: no scripted answer for ${String(input)}`);
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json', ...next.headers } });
  }) as Http & { seen: Seen[] };
  impl.seen = seen;
  return impl;
};
const rpcOk = (structuredContent: Record<string, unknown>) => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } } });
const rpcToolError = (text: string) => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError: true } } });
const tokens = (n: number) => ({ status: 200, body: { access_token: `acc${n}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `ref${n}`, scope: 'hey' } });
const unauthorized = { status: 401, body: { error: 'invalid_token' }, headers: { 'www-authenticate': 'Bearer resource_metadata="https://hey.drovr.app/.well-known/oauth-protected-resource"' } };

test('credentialsPath and issuerOf', () => {
  assert.equal(credentialsPath('/Users/cadam'), '/Users/cadam/.config/hey/credentials.json');
  assert.equal(issuerOf('https://hey.drovr.app/mcp'), 'https://hey.drovr.app');
  assert.equal(issuerOf('https://hey.example.org:8443/mcp/'), 'https://hey.example.org:8443');
});

test('Review Focus 1: readCredentials: missing is null, malformed names the file and the fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hey-http-'));
  assert.equal(readCredentials(join(dir, 'none.json')), null);
  writeFileSync(join(dir, 'bad.json'), '{"access":"a"}');
  assert.throws(() => readCredentials(join(dir, 'bad.json')), /bad\.json is not a hey credentials file.*run hey login/);
  writeFileSync(join(dir, 'broken.json'), '{nope');
  assert.throws(() => readCredentials(join(dir, 'broken.json')), /broken\.json is not JSON.*run hey login/);
});

test('Review Focus 1: writeCredentials stages through a rename and leaves 0600 in a 0700 directory; delete is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'hey-home-'));
  const path = credentialsPath(home);
  writeCredentials(path, creds());
  assert.deepEqual(readCredentials(path), creds());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, '.config', 'hey')).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), creds(), 'plain JSON, nothing else in the file');
  writeCredentials(path, creds({ access: 'acc2' }));
  assert.equal(readCredentials(path)?.access, 'acc2');
  deleteCredentials(path);
  deleteCredentials(path);
  assert.equal(readCredentials(path), null);
});

test('refreshCredentials posts the rotation to the issuer and returns the new pair with an absolute expiry; invalid_grant is SignInExpired; a 502 is a plain error', async () => {
  const http = fakeHttp([tokens(2)]);
  const next = await refreshCredentials(http, creds(), () => T0);
  assert.deepEqual(next, creds({ access: 'acc2', refresh: 'ref2', expiresAt: new Date(T0 + 3_600_000).toISOString() }));
  assert.equal(http.seen[0]!.url, 'https://hey.drovr.app/mcp/token');
  assert.equal(new URLSearchParams(http.seen[0]!.body).get('grant_type'), 'refresh_token');
  assert.equal(new URLSearchParams(http.seen[0]!.body).get('refresh_token'), 'ref1');
  await assert.rejects(() => refreshCredentials(fakeHttp([{ status: 400, body: { error: 'invalid_grant', error_description: 'refresh token reuse detected; session revoked' } }]), creds(), () => T0), SignInExpired);
  await assert.rejects(() => refreshCredentials(fakeHttp([{ status: 502, body: 'bad gateway' }]), creds(), () => T0), /502/);
});

test('callToolOnce posts one JSON-RPC tools/call with the bearer, the Accept pair and the protocol version, and returns structuredContent', async () => {
  const http = fakeHttp([rpcOk({ id: '01A' })]);
  const out = await callToolOnce(http, ENDPOINT, 'acc1', 'send', { text: 'hi', from: 'f' });
  assert.deepEqual(out, { ok: true, value: { id: '01A' } });
  const req = http.seen[0]!;
  assert.equal(req.url, ENDPOINT);
  assert.equal(req.headers.authorization, 'Bearer acc1');
  assert.equal(req.headers.accept, 'application/json, text/event-stream');
  assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
  assert.deepEqual(JSON.parse(req.body), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send', arguments: { text: 'hi', from: 'f' } } });
});

test('callToolOnce: a tool error is thrown with its text, a JSON-RPC fault with its message, a 401 is returned, a 502 is thrown naming the host', async () => {
  await assert.rejects(() => callToolOnce(fakeHttp([rpcToolError('no message 01A')]), ENDPOINT, 'a', 'read', { id: '01A' }), (error: unknown) => error instanceof Error && error.message === 'no message 01A');
  await assert.rejects(() => callToolOnce(fakeHttp([{ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid arguments' } } }]), ENDPOINT, 'a', 'send', {}), /Invalid arguments/);
  assert.deepEqual(await callToolOnce(fakeHttp([unauthorized]), ENDPOINT, 'a', 'prefs', {}), { ok: false, status: 401 });
  await assert.rejects(() => callToolOnce(fakeHttp([{ status: 502, body: 'upstream' }]), ENDPOINT, 'a', 'prefs', {}), /hey\.drovr\.app answered 502/);
});

const caller = (http: Http, home: string, now = T0) => toolCaller({ http, endpoint: ENDPOINT, path: credentialsPath(home), nowMs: () => now });

test('toolCaller: no file is NotSignedIn before any request; a fresh token is used as is', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hey-home-'));
  const http = fakeHttp([rpcOk({ away: false })]);
  await assert.rejects(() => caller(http, home)('prefs', {}), NotSignedIn);
  assert.equal(http.seen.length, 0);
  writeCredentials(credentialsPath(home), creds());
  assert.deepEqual(await caller(http, home)('prefs', {}), { away: false });
  assert.equal(http.seen[0]!.headers.authorization, 'Bearer acc1');
});

test('toolCaller: a token within 60 s of expiry is refreshed before the call and the file is rewritten', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hey-home-'));
  writeCredentials(credentialsPath(home), creds({ expiresAt: new Date(T0 + 30_000).toISOString() }));
  const http = fakeHttp([tokens(2), rpcOk({ away: true })]);
  assert.deepEqual(await caller(http, home)('prefs', {}), { away: true });
  assert.equal(http.seen[1]!.headers.authorization, 'Bearer acc2');
  assert.equal(readCredentials(credentialsPath(home))?.refresh, 'ref2');
});

test('Review Focus 2: toolCaller: a 401 refreshes once and retries once; a second 401 is SignInExpired', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hey-home-'));
  writeCredentials(credentialsPath(home), creds());
  const http = fakeHttp([unauthorized, tokens(2), rpcOk({ id: '01A' })]);
  assert.deepEqual(await caller(http, home)('send', { text: 'hi' }), { id: '01A' });
  assert.equal(http.seen.length, 3);
  assert.equal(http.seen[2]!.headers.authorization, 'Bearer acc2');
  const twice = fakeHttp([unauthorized, tokens(3), unauthorized]);
  await assert.rejects(() => caller(twice, home)('send', { text: 'hi' }), SignInExpired);
  assert.equal(twice.seen.length, 3, 'never a third attempt');
});

test('Review Focus 2: toolCaller: a 502 is thrown after one call, never retried; a refused refresh on the 401 path is SignInExpired', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hey-home-'));
  writeCredentials(credentialsPath(home), creds());
  const http = fakeHttp([{ status: 502, body: 'upstream' }]);
  await assert.rejects(() => caller(http, home)('send', { text: 'hi' }), /502/);
  assert.equal(http.seen.length, 1);
  const refused = fakeHttp([unauthorized, { status: 400, body: { error: 'invalid_grant' } }]);
  await assert.rejects(() => caller(refused, home)('send', { text: 'hi' }), SignInExpired);
});

test('toolCaller: credentials for another issuer than the endpoint are refused before any request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hey-home-'));
  writeCredentials(credentialsPath(home), creds({ issuer: 'https://hey.example.org' }));
  const http = fakeHttp([]);
  await assert.rejects(() => caller(http, home)('prefs', {}), /signed in to https:\/\/hey\.example\.org, but the endpoint is https:\/\/hey\.drovr\.app\/mcp: run hey login/);
  assert.equal(http.seen.length, 0);
});

test('every request carries a timeout signal of CALL_TIMEOUT_MS', async () => {
  let signal: AbortSignal | null | undefined;
  const http = (async (_input: string | URL | Request, init?: RequestInit) => { signal = init?.signal; return new Response(JSON.stringify(rpcOk({}).body), { status: 200 }); }) as Http;
  await callToolOnce(http, ENDPOINT, 'a', 'prefs', {});
  assert.ok(signal instanceof AbortSignal);
  assert.equal(CALL_TIMEOUT_MS, 15_000);
});
