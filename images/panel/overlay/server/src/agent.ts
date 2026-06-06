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
  tgForwardedImage,
  ensureInitialized,
  classifyError,
  readFileFromContainer,
  execInContainer,
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

const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 15; // 15 * 2s = 30s max wait for lock release

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Helper: run tg command with auto-init, spin-retry on refresh_locked, and semantic error handling
async function tgWithInit(
  inst: Instance,
  fn: () => Promise<TgExecResult>,
  reply: FastifyReply,
): Promise<TgExecResult | null> {
  // Auto-init with retry: if another request is refreshing, wait and retry
  for (let attempt = 0; ; attempt++) {
    const initResult = await ensureInitialized(inst);
    if (!initResult) break; // already initialized
    const initErr = classifyError(initResult);
    if (initErr?.code === 'refresh_locked' && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (initErr && initErr.code !== 'not_initialized') {
      reply.code(502).send({ error: initErr.code, message: initErr.message });
      return null;
    }
    break;
  }
  // Run command with retry
  for (let attempt = 0; ; attempt++) {
    const result = await fn();
    const err = classifyError(result);
    if (err?.code === 'refresh_locked' && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (err) {
      // Map error code → HTTP status. 502 is reserved for true upstream failures;
      // user-actionable conditions get more accurate codes.
      const statusByCode: Record<string, number> = {
        media_not_downloaded: 409,
        session_not_found: 404,
        not_logged_in: 401,
        not_initialized: 503,
        wechat_not_running: 503,
        ptrace_denied: 500,
        refresh_locked: 503,
        timeout: 504,
      };
      const code = statusByCode[err.code] ?? 502;
      reply.code(code).send({ error: err.code, message: err.message, detail: result.stderr || result.stdout });
      return null;
    }
    return result;
  }
}

// Return text output as { raw: ... } or try JSON parse
function formatOutput(result: TgExecResult) {
  const text = result.stdout.trim();
  try { return JSON.parse(text); } catch {}
  // Try NDJSON (one JSON object per line, e.g. from `tg query --format json`)
  const lines = text.split('\n').filter(l => l.startsWith('{'));
  if (lines.length > 0) {
    try {
      const results = lines.map(l => JSON.parse(l));
      return { results };
    } catch {}
  }
  return { raw: text };
}

// Like formatOutput but always wraps JSON objects in { results: [...] } for consistent array response
function formatQueryOutput(result: TgExecResult) {
  const text = result.stdout.trim();
  if (!text) return { results: [] };
  const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
  if (lines.length > 0) {
    try {
      const results = lines.map(l => JSON.parse(l));
      return { results };
    } catch {}
  }
  // Fallback: try single JSON parse
  try {
    const obj = JSON.parse(text);
    return { results: Array.isArray(obj) ? obj : [obj] };
  } catch {}
  // tg outputs "No rows returned." when there are zero matches
  if (text.startsWith('No rows') || text.startsWith('No messages')) return { results: [] };
  return { raw: text };
}

// Parse output of `tg forwarded-image --list`. Layout:
//   Index Time                Record-Id          Item       Type        Size Path
//   ----------...
//   1     2026-06-05 19:40:31 102fd13a9c49d337   1_0        orig       687KB /config/...
function parseForwardedList(stdout: string): { count: number; items: any[] } {
  const items: any[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line || /^[\s-]+$/.test(line) || line.startsWith('Index')) continue;
    // Match leading index + datetime + record + item + type + size + path
    const m = line.match(/^\s*(\d+)\s+(\S+\s+\S+)\s+(\S+)\s+(\S+)\s+(orig|thumb)\s+(\S+)\s+(\/\S.*)$/);
    if (!m) continue;
    items.push({
      index: parseInt(m[1], 10),
      time: m[2],
      recordId: m[3],
      item: m[4],
      type: m[5],
      size: m[6],
      path: m[7],
    });
  }
  return { count: items.length, items };
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
    return formatQueryOutput(result);
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

  // === Forwarded chat-history embedded images ===
  // List images embedded in forwarded-record (recordtype) messages.
  // Backed by `tg forwarded-image --list`. Images live under
  //   <attach>/<session-hash>/<month>/Rec/<record-id>/Img/<n>[_t]
  // and are V2-encrypted .dat files; export will decrypt when media keys are available.
  app.get('/api/agent/instances/:id/forwarded-images/list', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.session) return reply.code(400).send({ error: 'bad_request', message: 'session query parameter required' });
    const args = ['--list'];
    if (q.includeThumbs === '1' || q.includeThumbs === 'true') args.push('--include-thumbs');
    const result = await tgWithInit(inst, () => tgForwardedImage(inst, q.session, args), reply);
    if (!result) return;
    return parseForwardedList(result.stdout);
  });

  // Export by record-id (+ optional item), by index, or all.
  // Returns the decrypted image as a binary stream (Content-Type per detected ext).
  app.get('/api/agent/instances/:id/forwarded-images/export', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.session) return reply.code(400).send({ error: 'bad_request', message: 'session query parameter required' });
    const args: string[] = [];
    if (q.recordId) {
      args.push('--record-id', q.recordId);
      if (q.item) args.push('--item', q.item);
    } else if (q.index) {
      args.push('--index', q.index);
    } else {
      return reply.code(400).send({ error: 'bad_request', message: 'recordId or index required' });
    }
    if (q.includeThumbs === '1' || q.includeThumbs === 'true') args.push('--include-thumbs');
    const result = await tgWithInit(inst, () => tgForwardedImage(inst, q.session, args), reply);
    if (!result) return;
    const paths = result.stdout.split('\n').map(s => s.trim()).filter(p => p.startsWith('/'));
    if (paths.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'No images exported', detail: result.stdout });
    }
    // If multiple paths returned (e.g. --record-id alone), return a JSON manifest.
    if (paths.length > 1 && !q.item && !q.index) {
      return { count: paths.length, files: paths };
    }
    const filePath = paths[0];
    try {
      const buf = await readFileFromContainer(inst, filePath);
      if (buf.length === 0) return reply.code(404).send({ error: 'not_found', message: 'File empty or unreadable' });
      const filename = filePath.split('/').pop() || 'file';
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        bin: 'application/octet-stream', dat: 'application/octet-stream',
      };
      reply.header('Content-Type', mimeMap[ext] || 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      reply.header('X-TG-File-Path', filePath);
      if (ext === 'bin' || ext === 'dat') {
        reply.header('X-TG-Decryption', 'unavailable');
      }
      return reply.send(buf);
    } catch (e: any) {
      return reply.code(500).send({ error: 'file_read_error', message: e.message });
    }
  });

  // === Read arbitrary file from container (for embedded media like forwarded record images) ===
  app.get('/api/agent/instances/:id/file', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const q = req.query as Record<string, string>;
    if (!q.path) return reply.code(400).send({ error: 'bad_request', message: 'path query parameter required' });
    // Security: only allow paths under /config
    if (!q.path.startsWith('/config/')) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only paths under /config/ are allowed' });
    }
    try {
      const buf = await readFileFromContainer(inst, q.path);
      if (buf.length === 0) return reply.code(404).send({ error: 'not_found', message: 'File not found or empty' });
      const filename = q.path.split('/').pop() || 'file';
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        dat: 'application/octet-stream', pdf: 'application/pdf', mp4: 'video/mp4',
      };
      reply.header('Content-Type', mimeMap[ext] || 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return reply.send(buf);
    } catch (e: any) {
      return reply.code(500).send({ error: 'file_read_error', message: e.message });
    }
  });

  // === Scan temp image cache (for forwarded record images viewed in WeChat) ===
  app.get('/api/agent/instances/:id/temp-images', async (req, reply) => {
    const auth = agentAuth(req, reply, getUsers);
    if (!auth) return;
    const { id } = req.params as { id: string };
    const inst = getInstanceOrFail(reply, auth.user, auth.pat, id);
    if (!inst) return;
    const result = await execInContainer(inst, [
      'find', '/config/xwechat_files', '-type', 'f',
      '(', '-path', '*/temp/ImageUtils/*', '-o', '-path', '*/temp/ImageTemp/*', ')',
    ]);
    if (!result.ok) return reply.code(500).send({ error: 'unknown', message: result.stderr });
    const files = result.stdout.trim().split('\n').filter(Boolean);
    return { files: files.map(f => ({ path: f, name: f.split('/').pop() })) };
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
