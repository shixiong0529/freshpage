/**
 * SSRF 防护。
 *
 * 关键点：
 * 1. 必须解析 DNS 后校验真实 IP，仅检查主机名字符串无效；
 * 2. 每次重定向都要重新执行完整校验；
 * 3. 通过自定义 lookup 把连接固定到已校验的 IP，防止 DNS rebinding；
 * 4. 禁止 metadata 地址、私网、回环、链路本地与保留网段；
 * 5. 限制目标端口。
 */
import * as dns from 'node:dns';
import * as net from 'node:net';
import { config } from '../config';
import { isBlockedIpLiteral, parseIpLiteral } from './ip';
import { isPortAllowed, normalizeDomain } from './url';

export interface DnsCheckResult {
  ok: boolean;
  reason?: string;
  /** 已校验通过、可用于连接的 IP（防止 rebinding 时重新解析） */
  pinnedIp?: string;
  family?: 4 | 6;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

export function isBlockedHostname(hostname: string): boolean {
  const h = normalizeDomain(hostname).replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // 直接以 IP 字面量形式给出
  if (isBlockedIpLiteral(hostname)) return true;
  return false;
}

/** 校验主机名 + 端口，并在必要时解析 DNS 校验实际 IP。 */
export async function validateTarget(hostname: string, port: string | number): Promise<DnsCheckResult> {
  if (!hostname) return { ok: false, reason: 'missing_host' };

  const literal = parseIpLiteral(hostname.replace(/^\[|\]$/g, ''));
  if (literal) {
    if (isBlockedIpLiteral(hostname) && !config.allowPrivateTargets) {
      return { ok: false, reason: 'blocked_ip_literal' };
    }
    const ip = literal.version === 4 ? literal.bytes.join('.') : formatIpv6(literal.bytes);
    return { ok: true, pinnedIp: ip, family: literal.version };
  }

  if (isBlockedHostname(hostname) && !config.allowPrivateTargets) {
    return { ok: false, reason: 'blocked_hostname' };
  }

  // DNS 解析后校验真实 IP
  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolveAll(hostname);
  } catch {
    return { ok: false, reason: 'dns_failure' };
  }
  if (records.length === 0) return { ok: false, reason: 'dns_failure' };

  if (!config.allowPrivateTargets) {
    for (const r of records) {
      if (isBlockedIpLiteral(r.address)) {
        return { ok: false, reason: 'dns_resolves_to_private' };
      }
    }
  }

  const preferred = records.find((r) => r.family === 4) ?? records[0];
  return { ok: true, pinnedIp: preferred.address, family: preferred.family === 6 ? 6 : 4 };
}

export function resolveAll(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses.map((a) => ({ address: a.address, family: a.family })));
    });
  });
}

/** 生成一个把连接固定到指定 IP 的 lookup 回调，杜绝 DNS rebinding。 */
export function pinnedLookup(pinnedIp: string, family: 4 | 6) {
  return (
    hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void
  ): void => {
    void hostname;
    const opts = (options ?? {}) as { all?: boolean };
    if (opts.all) {
      callback(null, [{ address: pinnedIp, family }]);
    } else {
      callback(null, pinnedIp, family);
    }
  };
}

export function checkPort(url: { port: string; protocol: string }): boolean {
  if (config.allowPrivateTargets) return true;
  if (!url.port) return true;
  if (url.port === '80' && url.protocol === 'http:') return true;
  if (url.port === '443' && url.protocol === 'https:') return true;
  return config.allowedPorts.includes(url.port);
}

export function assertPortAllowed(url: URL): { ok: boolean; reason?: string } {
  if (!isPortAllowed(url)) return { ok: false, reason: 'blocked_port' };
  return { ok: true };
}

export function formatIpv6(bytes: number[]): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(':');
}

/** 同步快速判断（不查 DNS），用于提交阶段的即时反馈。 */
export function quickBlockCheck(hostname: string): { ok: boolean; reason?: string } {
  if (!hostname) return { ok: false, reason: 'missing_host' };
  if (isBlockedHostname(hostname)) return { ok: false, reason: 'blocked_hostname' };
  return { ok: true };
}

export function isIpLiteral(hostname: string): boolean {
  return parseIpLiteral(hostname.replace(/^\[|\]$/g, '')) !== null;
}

export function isPrivateOrLoopback(address: string): boolean {
  if (net.isIP(address)) return isBlockedIpLiteral(address);
  return false;
}
