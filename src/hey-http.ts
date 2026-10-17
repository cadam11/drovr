import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_ENDPOINT = 'https://hey.drovr.app/mcp';
/** The same bound the Lambda invoke had: one network call, and the shim answers in well under it. */
export const CALL_TIMEOUT_MS = 15_000;
/** Refresh this close to expiry rather than at it, so a call that starts valid does not land expired. */
export const REFRESH_SKEW_MS = 60_000;
/** In the server SDK's SUPPORTED_PROTOCOL_VERSIONS (1.30.0: 2025-11-25, 2025-06-18, 2025-03-26, …); an absent header would be read as 2025-03-26. */
export const PROTOCOL_VERSION = '2025-06-18';
export const DEVICE_CLIENT_ID = 'hey-cli';

export class NotSignedIn extends Error {
  constructor() {
    super('not signed in: run hey login');
  }
}
export class SignInExpired extends Error {
  constructor(detail: string) {
    super(`sign-in expired or revoked (${detail}): run hey login`);
  }
}

const credentialsShape = z.object({ access: z.string().min(1), refresh: z.string().min(1), expiresAt: z.string().datetime(), issuer: z.string().url() });
export type Credentials = z.infer<typeof credentialsShape>;
export type Http = typeof fetch;

export const credentialsPath = (home: string): string => join(home, '.config', 'hey', 'credentials.json');
export const issuerOf = (endpoint: string): string => new URL(endpoint).origin;

export const readCredentials = (path: string): Credentials | null => {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not JSON (${error instanceof Error ? error.message : String(error)}): run hey login`);
  }
  const parsed = credentialsShape.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not a hey credentials file (${parsed.error.issues[0]?.path.join('.') ?? 'shape'}): run hey login`);
  return parsed.data;
};

/** Staged through a rename so a concurrent reader (the tick, another hey) never sees half a file; 0600 because it is a bearer. */
export const writeCredentials = (path: string, creds: Credentials): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(staged, 0o600);
  renameSync(staged, path);
};

export const deleteCredentials = (path: string): void => {
  rmSync(path, { force: true });
};

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const tokenResponseShape = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number() });
const oauthErrorShape = z.object({ error: z.string(), error_description: z.string().optional() });

const readJson = async (res: Response, what: string): Promise<{ text: string; body: unknown }> => {
  const text = await res.text();
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    throw new Error(`${what} answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}`);
  }
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** RFC 6749 §6 against the shim's own token endpoint; the layout under the issuer is the shim's (`urlsOf`), so no metadata round trip. */
export const refreshCredentials = async (http: Http, creds: Credentials, nowMs: () => number): Promise<Credentials> => {
  const res = await http(`${creds.issuer}/mcp/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refresh, client_id: DEVICE_CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (res.ok) {
    const tokens = tokenResponseShape.parse((await readJson(res, 'token refresh')).body);
    return { access: tokens.access_token, refresh: tokens.refresh_token, expiresAt: new Date(nowMs() + tokens.expires_in * 1000).toISOString(), issuer: creds.issuer };
  }
  const text = await res.text();
  const refusal = oauthErrorShape.safeParse(safeJson(text));
  if (refusal.success && refusal.data.error === 'invalid_grant') throw new SignInExpired(refusal.data.error_description ?? 'invalid_grant');
  throw new Error(`token refresh at ${creds.issuer} answered ${res.status}: ${text.slice(0, 200)}`);
};

const rpcResultShape = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    structuredContent: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
  }),
});
const rpcFaultShape = z.object({ error: z.object({ code: z.number(), message: z.string() }) });

export type CallOutcome = { ok: true; value: unknown } | { ok: false; status: 401 };

/**
 * One JSON-RPC `tools/call` against a stateless JSON-response server: no initialize, no
 * session id (router.spec.ts proves the shim accepts exactly this). A tool error is thrown
 * with the tool's own text, which is what the Lambda's FunctionError used to carry.
 */
export const callToolOnce = async (http: Http, endpoint: string, access: string, tool: string, args: Record<string, unknown>): Promise<CallOutcome> => {
  const res = await http(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, authorization: `Bearer ${access}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (res.status === 401) return { ok: false, status: 401 };
  if (!res.ok) throw new Error(`${new URL(endpoint).host} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { body } = await readJson(res, `hey ${tool}`);
  const fault = rpcFaultShape.safeParse(body);
  if (fault.success) throw new Error(`hey ${tool}: ${fault.data.error.message}`);
  const parsed = rpcResultShape.parse(body);
  const text = parsed.result.content[0]?.text;
  if (parsed.result.isError === true) throw new Error(text ?? `hey ${tool} failed`);
  return { ok: true, value: parsed.result.structuredContent ?? (text === undefined ? null : JSON.parse(text)) };
};

export type CallerDeps = { http: Http; endpoint: string; path: string; nowMs: () => number };

const rotate = async (deps: CallerDeps, creds: Credentials): Promise<Credentials> => {
  const next = await refreshCredentials(deps.http, creds, deps.nowMs);
  writeCredentials(deps.path, next);
  return next;
};

/**
 * The caller every command and drovr's own sends use. Refresh before expiry; on a 401
 * refresh once and retry once — safe for a send, because the shim refuses the bearer before
 * any tool runs, so nothing was sent; anything else is thrown after one attempt, since a
 * retried send is a duplicate message and a retried read is the wait loop's job.
 */
export const toolCaller =
  (deps: CallerDeps) =>
  async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    let creds = readCredentials(deps.path);
    if (creds === null) throw new NotSignedIn();
    if (creds.issuer !== issuerOf(deps.endpoint)) throw new Error(`signed in to ${creds.issuer}, but the endpoint is ${deps.endpoint}: run hey login`);
    if (Date.parse(creds.expiresAt) - REFRESH_SKEW_MS <= deps.nowMs()) creds = await rotate(deps, creds);
    const first = await callToolOnce(deps.http, deps.endpoint, creds.access, tool, args);
    if (first.ok) return first.value;
    creds = await rotate(deps, creds);
    const second = await callToolOnce(deps.http, deps.endpoint, creds.access, tool, args);
    if (second.ok) return second.value;
    throw new SignInExpired('the refreshed token was refused');
  };

// ─── Device login (RFC 8628, the client side) ─────────────────────────────────

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Caps the server's expires_in so the loop is bounded even against a server that claims a code lives for days. */
export const MAX_DEVICE_LIFETIME_SEC = 30 * 60;
export const SLOW_DOWN_STEP_MS = 5_000;
export const MAX_POLL_INTERVAL_MS = 60_000;

const deviceShape = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});
export type DeviceAuthorization = z.infer<typeof deviceShape>;

export const startDeviceLogin = async (http: Http, issuer: string): Promise<DeviceAuthorization> => {
  const res = await http(`${issuer}/mcp/device_authorization`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ client_id: DEVICE_CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const { text, body } = await readJson(res, 'device authorization');
  if (!res.ok) throw new Error(`device authorization at ${issuer} answered ${res.status}: ${text.slice(0, 200)}`);
  const parsed = deviceShape.safeParse(body);
  if (!parsed.success) throw new Error(`device authorization answer is missing ${parsed.error.issues[0]?.path.join('.') ?? 'a field'}`);
  return parsed.data;
};

export type DevicePoll = { outcome: 'signed-in'; credentials: Credentials } | { outcome: 'denied' } | { outcome: 'expired' };
type PollAnswer = { kind: 'tokens'; credentials: Credentials } | { kind: 'pending' } | { kind: 'slow_down' } | { kind: 'denied' } | { kind: 'expired' };

const pollOnce = async (http: Http, issuer: string, deviceCode: string, nowMs: () => number): Promise<PollAnswer> => {
  const res = await http(`${issuer}/mcp/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: DEVICE_CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const { text, body } = await readJson(res, 'device token poll');
  if (res.ok) {
    const tokens = tokenResponseShape.parse(body);
    return { kind: 'tokens', credentials: { access: tokens.access_token, refresh: tokens.refresh_token, expiresAt: new Date(nowMs() + tokens.expires_in * 1000).toISOString(), issuer } };
  }
  const refusal = oauthErrorShape.safeParse(body);
  if (!refusal.success) throw new Error(`device token poll answered ${res.status}: ${text.slice(0, 200)}`);
  const code = refusal.data.error;
  if (code === 'authorization_pending') return { kind: 'pending' };
  if (code === 'slow_down') return { kind: 'slow_down' };
  if (code === 'access_denied') return { kind: 'denied' };
  if (code === 'expired_token') return { kind: 'expired' };
  throw new Error(`device token poll refused: ${code} ${refusal.data.error_description ?? ''}`.trim());
};

/**
 * Bounded three ways: the deadline (expires_in, clamped), a poll count sized for the smallest
 * interval, and the 60 s cap on how far slow_down can stretch the interval. Sleeps before every
 * poll, as RFC 8628 §3.5 says, so the first poll is never inside the server's interval.
 */
export const pollDeviceLogin = async (opts: { http: Http; issuer: string; device: DeviceAuthorization; sleep: (ms: number) => Promise<void>; nowMs: () => number }): Promise<DevicePoll> => {
  const lifetimeMs = Math.min(opts.device.expires_in, MAX_DEVICE_LIFETIME_SEC) * 1000;
  const deadline = opts.nowMs() + lifetimeMs;
  let intervalMs = opts.device.interval * 1000;
  const maxPolls = Math.ceil(lifetimeMs / intervalMs) + 1;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (opts.nowMs() + intervalMs > deadline) return { outcome: 'expired' };
    await opts.sleep(intervalMs);
    const answer = await pollOnce(opts.http, opts.issuer, opts.device.device_code, opts.nowMs);
    if (answer.kind === 'tokens') return { outcome: 'signed-in', credentials: answer.credentials };
    if (answer.kind === 'denied') return { outcome: 'denied' };
    if (answer.kind === 'expired') return { outcome: 'expired' };
    if (answer.kind === 'slow_down') intervalMs = Math.min(intervalMs + SLOW_DOWN_STEP_MS, MAX_POLL_INTERVAL_MS);
  }
  return { outcome: 'expired' };
};

/** RFC 7009 with the refresh token: the shim revokes the whole session for either token (plan 7). */
export const revokeCredentials = async (http: Http, creds: Credentials): Promise<void> => {
  const res = await http(`${creds.issuer}/mcp/revoke`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ token: creds.refresh }).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`revoke at ${creds.issuer} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
};
