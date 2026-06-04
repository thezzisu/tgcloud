import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  findById,
  findInstance,
  userCanAccess,
  userInstances,
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
  tgRefresh,
  tgSessions,
  tgUnread,
  tgMessages,
  tgSearch,
  tgQuery,
  tgDoctor,
  tgExport,
  tgMedia,
  ensureInitialized,
  classifyError,
  readFileFromContainer,
  listFilesInContainer,
  type TgExecResult,
} from './tg-exec.js';
import { instanceRuntime, wechatStatus } from './docker.js';

interface UserWithTokens extends User {
  tokens?: PatRecord[];
}

// --- PAT auth ---
function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  const token = parts[1];
  if (!token.startsWith('tgcp_')) return null;
  return token;
}

function resolveToken(token: string, getUsers: () => UserWithTokens[]): { user: UserWithTokens; pat: PatRecord } | null {
  for (const user of getUsers()) {
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

function agentAuth(req: FastifyRequest, reply: FastifyReply, getUsers: () => UserWithTokens[]): { user: UserWithTokens; pat: PatRecord } | null {
  const token = extractBearer(req);
  if (!token) { reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid Authorization header' }); return null; }
  const result = resolveToken(token, getUsers);
  if (!result) { reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token' }); return null; }
  return result;
}

function canAccessInstance(user: UserWithTokens, pat: PatRecord, instanceId: string): boolean {
  if (!userCanAccess(user, instanceId)) return false;
  if (pat.instanceIds && pat.instanceIds.length > 0) return pat.instanceIds.includes(instanceId);
  return true;
}

function getInstanceOrFail(reply: FastifyReply, user: UserWithTokens, pat: PatRecord, instanceId: string): Instance | null {
  const inst = findInstance(instanceId);
  if (!inst) { reply.code(404).send({ error: 'not_found', message: 'Instance not found' }); return null; }
  if (!canAccessInstance(user, pat, instanceId)) { reply.code(403).send({ error: 'forbidden', message: 'Token does not have access to this instance' }); return null; }
  return inst;
}

// Helper: run tg command with auto-init and semantic error handling
async function tgWithInit(
  inst: Instance,
  fn: () => Promise<TgExecResult>,
  reply: FastifyReply,
): Promise<TgExecResult | null> {
  const initResult = await ensureInitialized(inst);
  if (initResult) {
    const initErr = classifyError(initResult);
    if (initErr && initErr.code !== 'not_initialized') {
      reply.code(502).send({ error: initErr.code, message: initErr.message });
      return null;
    }
  }
  const result = await fn();
  const err = classifyError(result);
  if (err) {
    reply.code(502).send({ error: err.code, message: err.message, detail: result.stderr || result.stdout });
    return null;
  }
  return result;
}

// Return text output as { raw: ... } or try JSON parse
function formatOutput(result: TgExecResult) {
  const text = result.stdout.trim();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export function registerAgentRoutes(app: FastifyInstance, getUsers: () => UserWithTokens[], persist: () => void) {

  // === Instance management ===
  app.get('/api/agent/instances', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    let instances = userInstances(auth.user);
    if (auth.pat.instanceIds?.length) {
      const allowed = new Set(auth.pat.instanceIds);
      instances = instances.filter((i: Instance) => allowed.has(i.id));
    }
    return { instances: instances.map((i: Instance) => ({ id: i.id, name: i.name })) };
  });

  app.get('/api/agent/instances/:id/status', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const [runtime, wechat] = await Promise.all([instanceRuntime(inst), wechatStatus(inst)]);
    return { instanceId: id, runtime, wechat };
  });

  // === Data endpoints (auto-init) ===
  app.post('/api/agent/instances/:id/refresh', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const result = await tgRefresh(inst);
    const err = classifyError(result);
    if (err) return { ok: false, error: err.code, message: err.message };
    return { ok: true, detail: result.stdout };
  });

  app.get('/api/agent/instances/:id/sessions', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    const args: string[] = [];
    if (q.top) args.push('--top', q.top);
    const result = await tgWithInit(inst, () => tgSessions(inst, args), reply);
    if (!result) return;
    return formatOutput(result);
  });

  app.get('/api/agent/instances/:id/unread', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const result = await tgWithInit(inst, () => tgUnread(inst), reply);
    if (!result) return;
    return formatOutput(result);
  });

  app.get('/api/agent/instances/:id/messages', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.session) return reply.code(400).send({ error: 'bad_request', message: 'session query parameter required' });
    const args: string[] = [];
    if (q.limit) args.push('--limit', q.limit);
    if (q.since) args.push('--since', q.since);
    if (q.all_time === 'true') args.push('--all-time');
    if (q.offset) args.push('--offset', q.offset);
    if (q.search) args.push('--search', q.search);
    if (q.time_bucket) args.push('--time-bucket', q.time_bucket);
    const result = await tgWithInit(inst, () => tgMessages(inst, q.session, args), reply);
    if (!result) return;
    return formatOutput(result);
  });

  app.get('/api/agent/instances/:id/search', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.q) return reply.code(400).send({ error: 'bad_request', message: 'q query parameter required' });
    const args: string[] = [];
    if (q.limit) args.push('--limit', q.limit);
    if (q.since) args.push('--since', q.since);
    if (q.all_time === 'true') args.push('--all-time');
    const result = await tgWithInit(inst, () => tgSearch(inst, q.q, args), reply);
    if (!result) return;
    return formatOutput(result);
  });

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
    const result = await tgWithInit(inst, () => tgQuery(inst, args), reply);
    if (!result) return;
    return formatOutput(result);
  });

  app.get('/api/agent/instances/:id/doctor', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    const result = await tgDoctor(inst, q.session);
    return formatOutput(result);
  });

  // === Export ===
  app.post('/api/agent/instances/:id/export', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const body = (req.body as any) ?? {};
    if (!body.session) return reply.code(400).send({ error: 'bad_request', message: 'session field required' });
    const args: string[] = [];
    if (body.since) args.push('--since', body.since);
    const result = await tgWithInit(inst, () => tgExport(inst, body.session, args), reply);
    if (!result) return;
    // Read exported files
    const files = await listFilesInContainer(inst, '/tmp/tg-export');
    return { ok: true, files, detail: result.stdout };
  });

  // === Media: list ===
  app.get('/api/agent/instances/:id/media/:type/list', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id, type } = req.params as { id: string; type: string };
    if (!['image', 'file', 'sticker', 'voice'].includes(type))
      return reply.code(400).send({ error: 'bad_request', message: 'type must be image, file, sticker, or voice' });
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.session) return reply.code(400).send({ error: 'bad_request', message: 'session query parameter required' });
    const args = ['--list'];
    if (q.limit) args.push('--limit', q.limit);
    if (q.since) args.push('--since', q.since);
    const result = await tgWithInit(inst, () => tgMedia(inst, type as any, q.session, args), reply);
    if (!result) return;
    return formatOutput(result);
  });

  // === Media: export single by index ===
  app.get('/api/agent/instances/:id/media/:type/export', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id, type } = req.params as { id: string; type: string };
    if (!['image', 'file', 'sticker', 'voice'].includes(type))
      return reply.code(400).send({ error: 'bad_request', message: 'type must be image, file, sticker, or voice' });
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.session) return reply.code(400).send({ error: 'bad_request', message: 'session query parameter required' });
    const args: string[] = [];
    if (q.index) args.push('--index', q.index);
    else if (q.id) args.push('--id', q.id);
    else args.push('--index', '1'); // default: latest
    const result = await tgWithInit(inst, () => tgMedia(inst, type as any, q.session, args), reply);
    if (!result) return;
    // tg outputs the exported file path on stdout
    const filePath = result.stdout.trim().split('\n').pop()?.trim();
    if (!filePath || filePath.startsWith('[') || filePath.startsWith('No ')) {
      return reply.code(404).send({ error: 'not_found', message: 'No media file found', detail: result.stdout });
    }
    try {
      const buf = await readFileFromContainer(inst, filePath);
      const filename = filePath.split('/').pop() || 'file';
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        pdf: 'application/pdf', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
        voice: 'application/octet-stream', silk: 'audio/silk',
      };
      const contentType = mimeMap[ext] || 'application/octet-stream';
      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      reply.header('X-TG-File-Path', filePath);
      return reply.send(buf);
    } catch (e: any) {
      return reply.code(500).send({ error: 'file_read_error', message: e.message });
    }
  });

  // === PAT management (cookie-authed) ===
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
