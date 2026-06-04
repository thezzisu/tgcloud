import Docker from 'dockerode';
import type { Instance } from './store.js';

const docker = new Docker();
const TG_BIN = '/usr/local/bin/tg';
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface TgExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function tgExec(inst: Instance, args: string[]): Promise<TgExecResult> {
  const c = docker.getContainer(inst.containerName);
  const cmd = [TG_BIN, ...args, '--format', 'json'];

  const exec = await c.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: 'abc',
    Env: ['HOME=/config', 'TG_HOME=/config/.tg'],
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  return await new Promise<TgExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;

    const timer = setTimeout(() => {
      stream.destroy();
      resolve({ ok: false, stdout, stderr: stderr + '\n[tg-exec] timeout', exitCode: -1 });
    }, EXEC_TIMEOUT_MS);

    const stdoutSink = {
      write: (b: Buffer) => {
        totalBytes += b.length;
        if (totalBytes <= MAX_OUTPUT_BYTES) stdout += b.toString('utf8');
      },
    } as any;

    const stderrSink = {
      write: (b: Buffer) => {
        totalBytes += b.length;
        if (totalBytes <= MAX_OUTPUT_BYTES) stderr += b.toString('utf8');
      },
    } as any;

    docker.modem.demuxStream(stream, stdoutSink, stderrSink);

    stream.on('end', async () => {
      clearTimeout(timer);
      try {
        const info = await exec.inspect();
        const exitCode = info.ExitCode ?? -1;
        resolve({ ok: exitCode === 0, stdout, stderr, exitCode });
      } catch (e) {
        reject(e);
      }
    });

    stream.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export async function tgRefresh(inst: Instance): Promise<TgExecResult> {
  return tgExec(inst, ['refresh']);
}

export async function tgSessions(inst: Instance, args: string[] = []): Promise<TgExecResult> {
  return tgExec(inst, ['sessions', ...args]);
}

export async function tgMessages(inst: Instance, session: string, args: string[] = []): Promise<TgExecResult> {
  return tgExec(inst, ['messages', session, ...args]);
}

export async function tgSearch(inst: Instance, query: string, args: string[] = []): Promise<TgExecResult> {
  return tgExec(inst, ['search', query, ...args]);
}

export async function tgQuery(inst: Instance, args: string[]): Promise<TgExecResult> {
  return tgExec(inst, ['query', ...args]);
}

export async function tgDoctor(inst: Instance, session?: string): Promise<TgExecResult> {
  const args = session ? ['doctor', session] : ['doctor'];
  return tgExec(inst, args);
}
