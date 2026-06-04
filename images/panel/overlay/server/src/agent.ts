import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  findById,
  findInstance,
  userCanAccess,
  userInstances,
  listInstances,
  type User,
  type Instance,
} from './store.js';
import {
  generateToken,
  hashToken,
  tokenSuffix,
  verifyTokenHash,
  isExpired,
  publicPat,
  type PatRecord,
} from './pat.js';
import {
  tgExec,
  tgRefresh,
  tgSessions,
  tgMessages,
  tgSearch,
  tgQuery,
  tgDoctor,
} from './tg-exec.js';
import { instanceRuntime, wechatStatus } from './docker.js';

// PAT storage is embedded in the user records in accounts.json.
// We access it via a simple in-memory map rebuilt on load.
// The store module will be patched to include `tokens: PatRecord[]` on User.

interface UserWithTokens extends User {
  tokens?: PatRecord[];
}

// --- PAT resolution from Bearer header ---
function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  const token = parts[1];
  if (!token.startsWith('tgcp_')) return null;
  return token;
}

// Brute linear scan over all users' tokens. Fine for typical scale (<100 tokens).
function resolveToken(token: string, getUsers: () => UserWithTokens[]): { user: UserWithTokens; pat: PatRecord } | null {
  const users = getUsers();
  for (const user of users) {
    if (!user.tokens || user.disabled) continue;
    for (const pat of user.tokens) {
      if (pat.revoked || isExpired(pat)) continue;
      if (verifyTokenHash(token, pat.hash)) {
        pat.lastUsedAt = new Date().toISOString();
        return { user, pat };
      }
    }
  }
  return null;
}

function agentAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  getUsers: () => UserWithTokens[],
): { user: UserWithTokens; pat: PatRecord } | null {
  const token = extractBearer(req);
  if (!token) {
    reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    return null;
  }
  const result = resolveToken(token, getUsers);
  if (!result) {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return null;
  }
  return result;
}

function canAccessInstance(user: UserWithTokens, pat: PatRecord, instanceId: string): boolean {
  if (!userCanAccess(user, instanceId)) return false;
  if (pat.instanceIds && pat.instanceIds.length > 0) {
    return pat.instanceIds.includes(instanceId);
  }
  return true;
}

function getInstanceOrFail(
  reply: FastifyReply,
  user: UserWithTokens,
  pat: PatRecord,
  instanceId: string,
): Instance | null {
  const inst = findInstance(instanceId);
  if (!inst) {
    reply.code(404).send({ error: 'Instance not found' });
    return null;
  }
  if (!canAccessInstance(user, pat, instanceId)) {
    reply.code(403).send({ error: 'Token does not have access to this instance' });
    return null;
  }
  return inst;
}

export function registerAgentRoutes(app: FastifyInstance, getUsers: () => UserWithTokens[], persist: () => void) {
  // List accessible instances
  app.get('/api/agent/instances', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { user, pat } = auth;
    let instances = userInstances(user);
    if (pat.instanceIds && pat.instanceIds.length > 0) {
      const allowed = new Set(pat.instanceIds);
      instances = instances.filter((i: Instance) => allowed.has(i.id));
    }
    return { instances: instances.map((i: Instance) => ({ id: i.id, name: i.name })) };
  });

  // Instance status
  app.get('/api/agent/instances/:id/status', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const [runtime, wechat] = await Promise.all([instanceRuntime(inst), wechatStatus(inst)]);
    return { instanceId: id, runtime, wechat };
  });

  // tg sessions
  app.get('/api/agent/instances/:id/sessions', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    const args: string[] = [];
    if (q.top) args.push('--top', q.top);
    const result = await tgSessions(inst, args);
    if (!result.ok) return reply.code(502).send({ error: 'tg sessions failed', detail: result.stderr });
    try { return JSON.parse(result.stdout); } catch { return { raw: result.stdout }; }
  });

  // tg messages
  app.get('/api/agent/instances/:id/messages', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.session) return reply.code(400).send({ error: 'session query parameter required' });
    const args: string[] = [];
    if (q.limit) args.push('--limit', q.limit);
    if (q.since) args.push('--since', q.since);
    if (q.all_time === 'true') args.push('--all-time');
    const result = await tgMessages(inst, q.session, args);
    if (!result.ok) return reply.code(502).send({ error: 'tg messages failed', detail: result.stderr });
    try { return JSON.parse(result.stdout); } catch { return { raw: result.stdout }; }
  });

  // tg search
  app.get('/api/agent/instances/:id/search', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.q) return reply.code(400).send({ error: 'q query parameter required' });
    const args: string[] = [];
    if (q.limit) args.push('--limit', q.limit);
    if (q.since) args.push('--since', q.since);
    if (q.all_time === 'true') args.push('--all-time');
    const result = await tgSearch(inst, q.q, args);
    if (!result.ok) return reply.code(502).send({ error: 'tg search failed', detail: result.stderr });
    try { return JSON.parse(result.stdout); } catch { return { raw: result.stdout }; }
  });

  // tg query
  app.post('/api/agent/instances/:id/query', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const body = (req.body as any) ?? {};
    const args: string[] = [];
    if (body.session) args.push('--session', body.session);
    if (body.contains) args.push('--contains', body.contains);
    if (body.not) args.push('--not', body.not);
    if (body.since) args.push('--since', body.since);
    if (body.fields) args.push('--fields', body.fields);
    if (body.limit) args.push('--limit', String(body.limit));
    if (body.all_time) args.push('--all-time');
    const result = await tgQuery(inst, args);
    if (!result.ok) return reply.code(502).send({ error: 'tg query failed', detail: result.stderr });
    try { return JSON.parse(result.stdout); } catch { return { raw: result.stdout }; }
  });

  // tg refresh
  app.post('/api/agent/instances/:id/refresh', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const result = await tgRefresh(inst);
    return { ok: result.ok, detail: result.ok ? result.stdout : result.stderr };
  });

  // tg doctor
  app.get('/api/agent/instances/:id/doctor', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    const result = await tgDoctor(inst, q.session);
    if (!result.ok) return reply.code(502).send({ error: 'tg doctor failed', detail: result.stderr });
    try { return JSON.parse(result.stdout); } catch { return { raw: result.stdout }; }
  });

  // --- PAT management (cookie-authed, for the web UI) ---
  app.get('/api/account/tokens', async (req, reply) => {
    const cookie = (req as any).cookies?.woc_sess;
    const session = cookie ? (await import('./sessions.js')).getSession(cookie) : null;
    if (!session) return reply.code(401).send({ error: 'Not logged in' });
    const user = findById(session.userId) as UserWithTokens | undefined;
    if (!user || user.disabled) return reply.code(401).send({ error: 'Not logged in' });
    return { tokens: (user.tokens || []).filter(t => !t.revoked).map(publicPat) };
  });

  app.post('/api/account/tokens', async (req, reply) => {
    const cookie = (req as any).cookies?.woc_sess;
    const session = cookie ? (await import('./sessions.js')).getSession(cookie) : null;
    if (!session) return reply.code(401).send({ error: 'Not logged in' });
    const user = findById(session.userId) as UserWithTokens | undefined;
    if (!user || user.disabled) return reply.code(401).send({ error: 'Not logged in' });
    const body = (req.body as any) ?? {};
    const label = String(body.label || '').trim().slice(0, 64) || 'default';
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds : undefined;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : undefined;

    const token = generateToken();
    const record: PatRecord = {
      id: randomUUID(),
      label,
      hash: hashToken(token),
      suffix: tokenSuffix(token),
      instanceIds,
      createdAt: new Date().toISOString(),
      expiresAt,
      revoked: false,
    };
    if (!user.tokens) user.tokens = [];
    user.tokens.push(record);
    persist();
    return { token, pat: publicPat(record) };
  });

  app.delete('/api/account/tokens/:tokenId', async (req, reply) => {
    const cookie = (req as any).cookies?.woc_sess;
    const session = cookie ? (await import('./sessions.js')).getSession(cookie) : null;
    if (!session) return reply.code(401).send({ error: 'Not logged in' });
    const user = findById(session.userId) as UserWithTokens | undefined;
    if (!user || user.disabled) return reply.code(401).send({ error: 'Not logged in' });
    const { tokenId } = req.params as { tokenId: string };
    const pat = (user.tokens || []).find(t => t.id === tokenId);
    if (!pat) return reply.code(404).send({ error: 'Token not found' });
    pat.revoked = true;
    persist();
    return { ok: true };
  });
}
