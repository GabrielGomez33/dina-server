// File: src/modules/digim/web/security/urlGuard.ts
// ============================================================================
// DIGIM WEB-RESEARCH — SSRF / URL SAFETY GUARD
// ============================================================================
//
// PURPOSE
// -------
// DINA fetches arbitrary, externally-influenced URLs (search results, source
// configs). Without a guard this is a textbook Server-Side Request Forgery
// (SSRF) surface: an attacker-supplied URL could point at the cloud metadata
// endpoint (169.254.169.254), a loopback admin panel, or an internal service.
//
// This module is the single choke point every outbound fetch must pass through.
// It follows OWASP SSRF-prevention guidance:
//   * Parse with the WHATWG URL API — never regex.                (structure)
//   * Enforce a scheme allowlist (http/https only).               (scheme)
//   * Reject embedded credentials (user:pass@host).               (parser confusion)
//   * Enforce a port allowlist.                                   (port)
//   * Resolve DNS and reject ANY answer in a private/loopback/    (network)
//     link-local/ULA/metadata/reserved range — for BOTH A and AAAA.
//   * Support host allow/deny lists for tighter deployments.      (policy)
//   * Re-validate on every redirect hop (done by the caller).     (redirect SSRF)
//
// KNOWN RESIDUAL RISK (documented, not hidden): a TOCTOU DNS-rebind window
// exists between our resolve-and-validate and the socket connect, because the
// global fetch performs its own name resolution. Mitigations: keep the host
// allowlist populated in hostile environments, and (future) pin the validated
// IP via a custom undici dispatcher `lookup`. This is called out in
// digim-web-research/EDGE_CASES.md.
// ============================================================================

import { promises as dnsPromises } from 'dns';
import net from 'net';
import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';

export interface UrlSafetyResult {
  safe: boolean;
  /** The normalized, parsed URL (present whenever parsing succeeded). */
  url?: URL;
  /** Machine-readable reason code when `safe` is false. */
  reason?: UrlUnsafeReason;
  /** Human-readable explanation. */
  detail?: string;
  /** IP addresses the host resolved to (for observability / audit). */
  resolvedAddresses?: string[];
}

export type UrlUnsafeReason =
  | 'parse_error'
  | 'bad_scheme'
  | 'embedded_credentials'
  | 'empty_host'
  | 'port_not_allowed'
  | 'host_denied'
  | 'host_not_allowed'
  | 'dns_resolution_failed'
  | 'private_address'
  | 'guard_error';

export class UrlSafetyError extends Error {
  public readonly reason: UrlUnsafeReason;
  public readonly targetUrl: string;
  constructor(message: string, reason: UrlUnsafeReason, targetUrl: string) {
    super(message);
    this.name = 'UrlSafetyError';
    this.reason = reason;
    this.targetUrl = targetUrl;
  }
}

// ----------------------------------------------------------------------------
// PUBLIC API
// ----------------------------------------------------------------------------

/**
 * Non-throwing safety check. Returns a structured result; never rejects except
 * for genuinely unexpected internal errors (which are captured as guard_error).
 */
export async function checkUrlSafety(
  rawUrl: string,
  cfg: DigimWebConfig = getDigimWebConfig()
): Promise<UrlSafetyResult> {
  // 1. Structural parse (WHATWG URL, never regex).
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'parse_error', detail: `Not a valid URL: ${truncate(rawUrl)}` };
  }

  // If the guard is disabled we still return the parsed URL so callers can use
  // it, but we surface a clear signal in logs at the caller.
  if (!cfg.ssrfGuardEnabled) {
    return { safe: true, url };
  }

  // 2. Scheme allowlist.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, url, reason: 'bad_scheme', detail: `Scheme not allowed: ${url.protocol}` };
  }

  // 3. Reject embedded credentials (a classic parser-confusion SSRF vector).
  if (url.username || url.password) {
    return { safe: false, url, reason: 'embedded_credentials', detail: 'URL must not contain credentials' };
  }

  // 4. Host must be present.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!host) {
    return { safe: false, url, reason: 'empty_host', detail: 'URL has no host' };
  }

  // 5. Port allowlist. An empty url.port means the scheme default (80/443),
  //    which we treat as allowed only if 80/443 are in the allow list.
  const effectivePort = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  if (!cfg.allowedPorts.includes(effectivePort)) {
    return { safe: false, url, reason: 'port_not_allowed', detail: `Port not allowed: ${effectivePort}` };
  }

  // 6. Denylist (host-suffix match) — always wins.
  if (matchesHostList(host, cfg.deniedHosts)) {
    return { safe: false, url, reason: 'host_denied', detail: `Host is denylisted: ${host}` };
  }

  // 7. Allowlist — when non-empty, the host MUST match.
  if (cfg.allowedHosts.length > 0 && !matchesHostList(host, cfg.allowedHosts)) {
    return { safe: false, url, reason: 'host_not_allowed', detail: `Host not in allowlist: ${host}` };
  }

  // 8. Resolve to IP(s) and validate the network layer.
  if (!cfg.blockPrivateRanges) {
    return { safe: true, url };
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (err) {
    return {
      safe: false,
      url,
      reason: 'dns_resolution_failed',
      detail: `DNS resolution failed for ${host}: ${(err as Error).message}`,
    };
  }

  if (addresses.length === 0) {
    return { safe: false, url, reason: 'dns_resolution_failed', detail: `No addresses resolved for ${host}` };
  }

  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      return {
        safe: false,
        url,
        reason: 'private_address',
        detail: `Host ${host} resolves to a blocked address: ${addr}`,
        resolvedAddresses: addresses,
      };
    }
  }

  return { safe: true, url, resolvedAddresses: addresses };
}

/**
 * Throwing variant for call sites that want fail-fast semantics.
 * Returns the validated URL on success.
 */
export async function assertUrlSafe(
  rawUrl: string,
  cfg: DigimWebConfig = getDigimWebConfig()
): Promise<URL> {
  const result = await checkUrlSafety(rawUrl, cfg);
  if (!result.safe) {
    throw new UrlSafetyError(
      result.detail || 'URL failed safety validation',
      result.reason || 'guard_error',
      rawUrl
    );
  }
  // checkUrlSafety guarantees url is set when safe.
  return result.url as URL;
}

// ----------------------------------------------------------------------------
// HOST LIST MATCHING
// ----------------------------------------------------------------------------

/**
 * Suffix-aware host matching. "example.com" matches "example.com" and any
 * subdomain "*.example.com", but NOT "notexample.com". IP literals match exactly.
 */
function matchesHostList(host: string, list: string[]): boolean {
  if (list.length === 0) return false;
  for (const entry of list) {
    const e = entry.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
    if (!e) continue;
    if (host === e) return true;
    if (host.endsWith(`.${e}`)) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// DNS RESOLUTION
// ----------------------------------------------------------------------------

/**
 * Resolve a host to all of its A and AAAA records. If the host is already an
 * IP literal it is returned verbatim (no lookup). Both families are queried so
 * an attacker cannot smuggle a private target via only-AAAA / only-A.
 */
async function resolveHost(host: string): Promise<string[]> {
  const ipVersion = net.isIP(host);
  if (ipVersion !== 0) {
    return [host];
  }

  const results = await Promise.allSettled([
    dnsPromises.resolve4(host),
    dnsPromises.resolve6(host),
  ]);

  const addresses: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      addresses.push(...r.value);
    }
  }

  // Fallback to a generic lookup if both specific families failed (covers
  // /etc/hosts entries and some resolver quirks resolve4/6 miss).
  if (addresses.length === 0) {
    const looked = await dnsPromises.lookup(host, { all: true });
    for (const l of looked) addresses.push(l.address);
  }

  return Array.from(new Set(addresses));
}

// ----------------------------------------------------------------------------
// IP CLASSIFICATION — the heart of the network-layer defense
// ----------------------------------------------------------------------------

/**
 * True if `addr` is a private/loopback/link-local/ULA/metadata/reserved
 * address that DINA must never connect to. Handles IPv4, IPv6, and the
 * IPv4-mapped / NAT64 forms that smuggle a v4 target inside a v6 literal.
 */
export function isPrivateAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) return isPrivateIPv4(addr);
  if (family === 6) return isPrivateIPv6(addr);
  // Not a recognizable IP → treat as unsafe (fail closed).
  return true;
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function inCidr4(ipInt: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const IPV4_BLOCKED_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],       // "this" network
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12],   // private
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.0.2.0', 24],    // TEST-NET-1
  ['192.168.0.0', 16],  // private
  ['198.18.0.0', 15],   // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24],  // TEST-NET-3
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved / future use (incl. 255.255.255.255)
];

function isPrivateIPv4(addr: string): boolean {
  const ipInt = ipv4ToInt(addr);
  if (ipInt === null) return true; // unparseable → fail closed
  for (const [base, prefix] of IPV4_BLOCKED_CIDRS) {
    if (inCidr4(ipInt, base, prefix)) return true;
  }
  return false;
}

/**
 * Expand an IPv6 literal to a 128-bit BigInt. Handles "::" compression and the
 * embedded-IPv4 dotted-quad tail (e.g. "::ffff:192.168.0.1"). Returns null on
 * malformed input (caller then fails closed).
 */
function ipv6ToBigInt(addr: string): bigint | null {
  let a = addr.trim();
  // Strip a zone id (fe80::1%eth0) — the address part is what matters.
  const pct = a.indexOf('%');
  if (pct !== -1) a = a.slice(0, pct);

  // Handle an embedded IPv4 tail by converting it to two hextets.
  const lastColon = a.lastIndexOf(':');
  const tail = lastColon !== -1 ? a.slice(lastColon + 1) : a;
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    a = a.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16);
  }

  const doubleColon = a.indexOf('::');
  let headParts: string[];
  let tailParts: string[];
  if (doubleColon !== -1) {
    const head = a.slice(0, doubleColon);
    const rest = a.slice(doubleColon + 2);
    headParts = head.length ? head.split(':') : [];
    tailParts = rest.length ? rest.split(':') : [];
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) return null;
    headParts = headParts.concat(new Array(missing).fill('0')).concat(tailParts);
  } else {
    headParts = a.split(':');
  }

  if (headParts.length !== 8) return null;

  let value = 0n;
  for (const part of headParts) {
    if (part.length === 0 || part.length > 4) return null;
    const n = parseInt(part, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff || /[^0-9a-f]/i.test(part)) return null;
    value = (value << 16n) + BigInt(n);
  }
  return value;
}

function inCidr6(ipBig: bigint, baseAddr: string, prefix: number): boolean {
  const baseBig = ipv6ToBigInt(baseAddr);
  if (baseBig === null) return false;
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return ipBig >> shift === baseBig >> shift;
}

const IPV6_BLOCKED_CIDRS: Array<[string, number]> = [
  ['::1', 128],        // loopback
  ['::', 128],         // unspecified
  ['fc00::', 7],       // unique local (ULA)
  ['fe80::', 10],      // link-local
  ['fec0::', 10],      // site-local (deprecated but still blocked)
  ['ff00::', 8],       // multicast
  ['2001:db8::', 32],  // documentation
  ['64:ff9b::', 96],   // NAT64 (embedded v4 handled separately below too)
  ['100::', 64],       // discard-only
];

function isPrivateIPv6(addr: string): boolean {
  const ipBig = ipv6ToBigInt(addr);
  if (ipBig === null) return true; // fail closed

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible — re-check the embedded v4.
  const v4MappedBase = ipv6ToBigInt('::ffff:0:0');
  if (v4MappedBase !== null && ipBig >> 32n === v4MappedBase >> 32n) {
    const embedded = Number(ipBig & 0xffffffffn) >>> 0;
    const dotted = [
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ].join('.');
    return isPrivateIPv4(dotted);
  }

  for (const [base, prefix] of IPV6_BLOCKED_CIDRS) {
    if (inCidr6(ipBig, base, prefix)) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// UTIL
// ----------------------------------------------------------------------------

function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
