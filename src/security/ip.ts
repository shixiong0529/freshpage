/**
 * IP 字面量解析与私网判定。
 *
 * 安全要求：不能通过简单字符串判断实现。必须支持十进制、八进制、十六进制等
 * 各种 IP 写法，并对 IPv4-mapped / NAT64 / 6to4 / Teredo 等隧道地址做解包校验。
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  /** 4 字节（v4）或 16 字节（v6），大端 */
  bytes: number[];
  /** 该地址内嵌的 IPv4（隧道地址），若无则为空 */
  embeddedV4?: number[];
}

function parseComponent(part: string): number | null {
  if (part.length === 0) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    const v = Number.parseInt(part.slice(2), 16);
    return Number.isFinite(v) && v <= 0xffffffff ? v : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const v = Number.parseInt(part, 8);
    return Number.isFinite(v) && v <= 0xffffffff ? v : null;
  }
  if (/^[0-9]+$/.test(part)) {
    const v = Number.parseInt(part, 10);
    return Number.isFinite(v) && v <= 0xffffffff ? v : null;
  }
  return null;
}

/** 解析 IPv4 字面量：支持 1~4 段，每段可为十进制 / 八进制 / 十六进制。 */
export function parseIpv4(host: string): number[] | null {
  if (host.length === 0) return null;
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  if (parts.some((p) => p.length === 0)) return null;

  const values: number[] = [];
  for (const p of parts) {
    const v = parseComponent(p);
    if (v === null) return null;
    values.push(v);
  }
  // 非最后一段不能超过 255
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 0xff) return null;
  }
  const last = values[values.length - 1];
  const remaining = 4 - values.length;
  // 最后一段可承载剩余所有字节
  if (last > Math.pow(256, remaining + 1) - 1) return null;

  const bytes = new Array<number>(4).fill(0);
  for (let i = 0; i < values.length - 1; i++) bytes[i] = values[i];
  let rest = last;
  for (let i = 3; i >= values.length - 1; i--) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

/** 解析 IPv6，返回 16 字节；支持 :: 压缩与内嵌 IPv4。 */
export function parseIpv6(host: string): number[] | null {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (!/^[0-9a-fA-F:.]+$/.test(h)) return null;
  if (h.split('::').length > 2) return null;

  // 处理尾部内嵌 IPv4，例如 ::ffff:127.0.0.1
  let v4: number[] | null = null;
  const lastColon = h.lastIndexOf(':');
  if (lastColon >= 0) {
    const tail = h.slice(lastColon + 1);
    if (tail.includes('.')) {
      v4 = parseIpv4(tail);
      if (!v4) return null;
      h = h.slice(0, lastColon + 1) + '0:0';
    }
  } else if (h.includes('.')) {
    v4 = parseIpv4(h);
    if (!v4) return null;
    h = '0:0';
  }

  let head: string[];
  let tail: string[];
  if (h.includes('::')) {
    const [a, b] = h.split('::');
    head = a === '' ? [] : a.split(':');
    tail = b === '' ? [] : b.split(':');
  } else {
    head = h.split(':');
    tail = [];
  }

  const groups: number[] = [];
  for (const g of head) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    groups.push(Number.parseInt(g, 16));
  }
  const tailGroups: number[] = [];
  for (const g of tail) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    tailGroups.push(Number.parseInt(g, 16));
  }

  const bytes = new Array<number>(16).fill(0);
  const total = groups.length + tailGroups.length;
  if (h.includes('::')) {
    if (total > 7) return null;
    for (let i = 0; i < groups.length; i++) {
      bytes[i * 2] = groups[i] >> 8;
      bytes[i * 2 + 1] = groups[i] & 0xff;
    }
    const tailStart = 8 - tailGroups.length;
    for (let i = 0; i < tailGroups.length; i++) {
      bytes[(tailStart + i) * 2] = tailGroups[i] >> 8;
      bytes[(tailStart + i) * 2 + 1] = tailGroups[i] & 0xff;
    }
  } else {
    if (total !== 8) return null;
    for (let i = 0; i < 8; i++) {
      bytes[i * 2] = groups[i] >> 8;
      bytes[i * 2 + 1] = groups[i] & 0xff;
    }
  }

  if (v4) {
    bytes[12] = v4[0];
    bytes[13] = v4[1];
    bytes[14] = v4[2];
    bytes[15] = v4[3];
  }
  return bytes;
}

export function parseIpLiteral(host: string): ParsedIp | null {
  const v6 = parseIpv6(host);
  if (v6) {
    const ip: ParsedIp = { version: 6, bytes: v6 };
    const mapped =
      v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff
        ? { embeddedV4: v6.slice(12), version: 4 as IpVersion }
        : null;
    // NAT64 64:ff9b::/96
    if (mapped) {
      ip.embeddedV4 = mapped.embeddedV4;
      return ip;
    }
    if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && v6.slice(4, 12).every((b) => b === 0)) {
      ip.embeddedV4 = v6.slice(12);
      return ip;
    }
    // 6to4 2002::/16
    if (v6[0] === 0x20 && v6[1] === 0x02) {
      ip.embeddedV4 = v6.slice(2, 6);
      return ip;
    }
    // Teredo 2001:0::/32 —— 服务器 IPv4 位于第 4~8 字节
    if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x00 && v6[3] === 0x00) {
      ip.embeddedV4 = v6.slice(4, 8);
      return ip;
    }
    return ip;
  }
  const v4 = parseIpv4(host);
  if (v4) return { version: 4, bytes: v4 };
  return null;
}

function inRange(bytes: number[], cidr: [number[], number]): boolean {
  const [base, bits] = cidr;
  const totalBits = bytes.length * 8;
  for (let i = 0; i < bits; i++) {
    const byteIndex = Math.floor(i / 8);
    const mask = 0x80 >> i % 8;
    const a = bytes[byteIndex] & mask;
    const b = base[byteIndex] & mask;
    if (a !== b) return false;
  }
  void totalBits;
  return true;
}

const V4_BLOCKED: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], // 0.0.0.0/8
  [[10, 0, 0, 0], 8], // 私有
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // 回环
  [[169, 254, 0, 0], 16], // 链路本地（含 169.254.169.254 metadata）
  [[172, 16, 0, 0], 12], // 私有
  [[192, 0, 0, 0], 24], // IETF 协议分配
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 中继任播
  [[192, 168, 0, 0], 16], // 私有
  [[198, 18, 0, 0], 15], // 基准测试
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // 组播
  [[240, 0, 0, 0], 4], // 保留 + 广播
];

export function isBlockedIpv4(bytes: number[]): boolean {
  return V4_BLOCKED.some((cidr) => inRange(bytes, cidr));
}

export function isBlockedIpv6(bytes: number[]): boolean {
  // v4-mapped / NAT64 / 6to4 / Teredo 已在 parseIpLiteral 中解出内嵌 v4
  const first = bytes[0];
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 唯一本地
  if (first === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 链路本地
  if (first === 0xff) return true; // 组播
  if (bytes.every((b) => b === 0)) return true; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
  if (first === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 文档地址
  return false;
}

/** 判断 IP 是否属于禁止访问范围（私网 / 回环 / 保留 / metadata）。 */
export function isBlockedIpLiteral(host: string): boolean {
  const parsed = parseIpLiteral(host);
  if (!parsed) return false;
  if (parsed.embeddedV4 && isBlockedIpv4(parsed.embeddedV4)) return true;
  return parsed.version === 4 ? isBlockedIpv4(parsed.bytes) : isBlockedIpv6(parsed.bytes);
}

export function formatIp(bytes: number[]): string {
  return bytes.join('.');
}
