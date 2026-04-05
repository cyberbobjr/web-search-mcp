/**
 * SSRF (Server-Side Request Forgery) protection.
 * Blocks requests to private IP ranges, loopback addresses, link-local addresses,
 * and cloud metadata endpoints to prevent SSRF attacks when LLMs supply arbitrary URLs.
 */

import { URL } from 'url';
import dns from 'dns/promises';

const PRIVATE_CIDR_PATTERNS: RegExp[] = [
  /^127\./,                        // loopback
  /^10\./,                         // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,   // RFC 1918
  /^192\.168\./,                   // RFC 1918
  /^169\.254\./,                   // link-local / AWS metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT
  /^::1$/,                         // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,             // IPv6 unique local
  /^fd[0-9a-f]{2}:/i,             // IPv6 unique local
  /^fe80:/i,                       // IPv6 link-local
  /^0\./,                          // this-network
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',              // AWS/GCP/Azure IMDS
  '100.100.100.200',              // Alibaba Cloud IMDS
]);

function isPrivateIp(ip: string): boolean {
  return PRIVATE_CIDR_PATTERNS.some(pattern => pattern.test(ip));
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(lower) || lower.endsWith('.local') || lower.endsWith('.internal');
}

/**
 * Validates a URL against SSRF risks.
 * Throws if the URL targets a private/reserved address.
 * Resolves the hostname via DNS and re-checks the resolved IP.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked protocol: ${parsed.protocol}. Only http and https are allowed.`);
  }

  const hostname = parsed.hostname;

  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  if (isPrivateIp(hostname)) {
    throw new Error(`Blocked IP address: ${hostname}`);
  }

  // DNS resolution check — catches cases where a public hostname resolves to a private IP
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        throw new Error(`Hostname ${hostname} resolves to a private IP address: ${address}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Hostname')) {
      throw err;  // re-throw our own SSRF errors
    }
    // DNS lookup failure (NXDOMAIN, etc.) — let the upstream request fail naturally
  }
}
