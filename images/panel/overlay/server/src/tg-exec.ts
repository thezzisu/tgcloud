import Docker from 'dockerode';
import type { Instance } from './store.js';

const docker = new Docker();
const TG_BIN = '/usr/local/bin/tg';
const EXEC_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface TgExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Semantic error codes for the API layer
export type TgErrorCode =
  | 'not_logged_in'
  | 'not_initialized'
  | 'refresh_locked'
  | 'wechat_not_running'
  | 'ptrace_denied'
  | 'session_not_found'
  | 'media_not_downloaded'
  | 'timeout'
  | 'unknown';

export interface TgSemanticError {
  code: TgErrorCode;
  message: string;
}

export function classifyError(result: TgExecResult): TgSemanticError | null {
  const out = result.stdout + result.stderr;
  // tg commands may warn about lock contention in stderr but still succeed.
  // Only treat refresh_locked as an error when the command itself failed.
  if (!result.ok && (out.includes('already running') || out.includes('refresh.lock')))
    return { code: 'refresh_locked', message: 'A refresh is already in progress. Try again later.' };
  if (out.includes('decrypted cache is still incomplete'))
    return { code: 'not_logged_in', message: 'Cannot decrypt databases. WeChat may not be logged in or keys are unavailable.' };
  if (out.includes('No match for'))
    return { code: 'session_not_found', message: 'Session not found. Check the session name or ID.' };
  // Image / file / voice not downloaded yet — WeChat caches HD originals only after the user views them.
  // tg surfaces this as e.g. "Image #3 is not available in local Telegram cache" or
  // "File #5 is not available in local Telegram cache".
  if (out.match(/is not available in local Telegram cache/))
    return {
      code: 'media_not_downloaded',
      message:
        'The HD original of this media has not been downloaded to the WeChat client yet. ' +
        'Please open the message in the WeChat UI (via VNC) so the user can tap/click it; ' +
        'WeChat will then fetch the file from the CDN and cache it locally. Retry afterwards.',
    };
  if (out.includes('[tg-exec] timeout'))
    return { code: 'timeout', message: 'Command timed out.' };
  if (out.includes('Telegram is not running') || out.includes('not running'))
    return { code: 'wechat_not_running', message: 'WeChat is not running in this instance.' };
  if (out.includes('ptrace') || out.includes('permission error'))
    return { code: 'ptrace_denied', message: 'Key extraction denied. Instance may lack CAP_SYS_PTRACE.' };
  if (!result.ok && (out.includes('0 unique key candidates') || out.includes('Found 0 database keys')))
    return { code: 'not_logged_in', message: 'WeChat is not logged in or has not loaded databases yet. Please log in via the VNC interface.' };
  if (out.includes('No sessions found') || out.includes('keys: MISSING'))
    return { code: 'not_initialized', message: 'WeChat data not initialized. Call POST /refresh first.' };
  if (!result.ok)
    return { code: 'unknown', message: result.stderr || result.stdout || 'Unknown error' };
  return null;
}

// Check if tg is initialized (keys + decrypted cache exist)
export async function isInitialized(inst: Instance): Promise<boolean> {
  const c = docker.getContainer(inst.containerName);
  try {
    const exec = await c.exec({
      Cmd: ['sh', '-c', 'test -f /config/.tg/all_keys.json && test -d /config/.tg/decrypted'],
      AttachStdout: true, AttachStderr: true, Tty: false, User: 'abc',
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => { stream.on('end', resolve); stream.on('error', resolve); stream.resume(); });
    const info = await exec.inspect();
    return info.ExitCode === 0;
  } catch { return false; }
}

// Auto-init: ensure keys + decrypted cache exist before reading
export async function ensureInitialized(inst: Instance): Promise<TgExecResult | null> {
  if (await isInitialized(inst)) return null;
  return tgRefresh(inst);
}

export function execInContainer(
  inst: Instance,
  cmd: string[],
  opts: { user?: string; timeout?: number } = {},
): Promise<TgExecResult> {
  const c = docker.getContainer(inst.containerName);
  const timeout = opts.timeout ?? EXEC_TIMEOUT_MS;

  return new Promise(async (resolve, reject) => {
    try {
      const exec = await c.exec({
        Cmd: cmd,
        AttachStdout: true, AttachStderr: true, Tty: false,
        User: opts.user || 'abc',
        Env: ['HOME=/config', 'TG_HOME=/config/.tg'],
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      let stdout = '', stderr = '', totalBytes = 0;

      const timer = setTimeout(() => {
        stream.destroy();
        resolve({ ok: false, stdout, stderr: stderr + '\n[tg-exec] timeout', exitCode: -1 });
      }, timeout);

      const stdoutSink = { write: (b: Buffer) => { totalBytes += b.length; if (totalBytes <= MAX_OUTPUT_BYTES) stdout += b.toString('utf8'); } } as any;
      const stderrSink = { write: (b: Buffer) => { totalBytes += b.length; if (totalBytes <= MAX_OUTPUT_BYTES) stderr += b.toString('utf8'); } } as any;
      docker.modem.demuxStream(stream, stdoutSink, stderrSink);

      stream.on('end', async () => {
        clearTimeout(timer);
        try {
          const info = await exec.inspect();
          resolve({ ok: (info.ExitCode ?? -1) === 0, stdout, stderr, exitCode: info.ExitCode ?? -1 });
        } catch (e) { reject(e); }
      });
      stream.on('error', (e) => { clearTimeout(timer); reject(e); });
    } catch (e) { reject(e); }
  });
}

export async function tgExec(inst: Instance, args: string[], jsonFormat = false): Promise<TgExecResult> {
  const cmd = jsonFormat ? [TG_BIN, ...args, '--format', 'json'] : [TG_BIN, ...args];
  // Run as root so tg's internal silent refresh can extract keys via ptrace.
  // The ensureInitialized path already chowns /config/.tg to abc.
  return execInContainer(inst, cmd, { user: 'root' });
}

export async function tgRefresh(inst: Instance): Promise<TgExecResult> {
  const cmd = [
    'sh', '-c',
    'TG_HOME=/config/.tg HOME=/config /usr/local/bin/tg keys 2>&1; ' +
    'TG_HOME=/config/.tg HOME=/config /usr/local/bin/tg refresh 2>&1; ' +
    'chown -R abc:abc /config/.tg 2>/dev/null; ' +
    'echo "done"'
  ];
  return execInContainer(inst, cmd, { user: 'root', timeout: EXEC_TIMEOUT_MS });
}

export async function tgSessions(inst: Instance, args: string[] = []): Promise<TgExecResult> {
  return tgExec(inst, ['sessions', ...args]);
}

export async function tgUnread(inst: Instance): Promise<TgExecResult> {
  return tgExec(inst, ['unread']);
}

export async function tgMessages(inst: Instance, session: string, args: string[] = []): Promise<TgExecResult> {
  return tgExec(inst, ['messages', session, ...args]);
}

export async function tgSearch(inst: Instance, query: string, args: string[] = []): Promise<TgExecResult> {
  return tgExec(inst, ['search', query, ...args]);
}

export async function tgQuery(inst: Instance, args: string[]): Promise<TgExecResult> {
  return tgExec(inst, ['query', ...args], true);
}

export async function tgDoctor(inst: Instance, session?: string): Promise<TgExecResult> {
  const args = session ? ['doctor', session] : ['doctor'];
  return tgExec(inst, args);
}

export async function tgExport(inst: Instance, session: string, args: string[] = []): Promise<TgExecResult> {
  return execInContainer(inst, [TG_BIN, 'export', session, '--output', '/tmp/tg-export', ...args], { timeout: MEDIA_TIMEOUT_MS });
}

// Media: list or export. Returns text output for --list, or file path for export.
export async function tgMedia(
  inst: Instance,
  type: 'image' | 'file' | 'sticker' | 'voice',
  session: string,
  args: string[] = [],
): Promise<TgExecResult> {
  return execInContainer(inst, [TG_BIN, type, session, '--output', `/tmp/tg-media-${type}`, ...args], { user: 'root', timeout: MEDIA_TIMEOUT_MS });
}

export async function tgForwardedImage(
  inst: Instance,
  session: string,
  args: string[] = [],
): Promise<TgExecResult> {
  return execInContainer(inst, [TG_BIN, 'forwarded-image', session, '--output', '/tmp/tg-forwarded-images', ...args], { user: 'root', timeout: MEDIA_TIMEOUT_MS });
}

// Read a file from the container and return as Buffer
export async function readFileFromContainer(inst: Instance, path: string): Promise<Buffer> {
  const c = docker.getContainer(inst.containerName);
  const stream = (await c.getArchive({ path })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const tar = Buffer.concat(chunks);
  if (tar.length < 512) return Buffer.alloc(0);
  const sizeStr = tar.toString('ascii', 124, 135).replace(/\0/g, '').trim();
  const size = parseInt(sizeStr, 8) || 0;
  return tar.subarray(512, 512 + size);
}

// List files in a container directory
export async function listFilesInContainer(inst: Instance, dir: string): Promise<string[]> {
  const result = await execInContainer(inst, ['find', dir, '-maxdepth', '1', '-type', 'f', '-printf', '%f\\n']);
  if (!result.ok) return [];
  return result.stdout.split('\n').filter(Boolean);
}
