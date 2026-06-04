import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export interface PatRecord {
  id: string;
  label: string;
  hash: string;
  suffix: string;
  instanceIds?: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revoked: boolean;
}

const PREFIX = 'tgcp_';
const TOKEN_BYTES = 32;

export function generateToken(): string {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  return PREFIX + raw;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenSuffix(token: string): string {
  return token.slice(-6);
}

export function verifyTokenHash(token: string, hash: string): boolean {
  const computed = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(hash, 'hex');
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

export function isExpired(pat: PatRecord): boolean {
  if (!pat.expiresAt) return false;
  return new Date(pat.expiresAt).getTime() < Date.now();
}

export function publicPat(pat: PatRecord) {
  return {
    id: pat.id,
    label: pat.label,
    suffix: pat.suffix,
    instanceIds: pat.instanceIds,
    createdAt: pat.createdAt,
    lastUsedAt: pat.lastUsedAt,
    expiresAt: pat.expiresAt,
    revoked: pat.revoked,
  };
}
