import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Ranges a merchant's webhook URL may not point at (SSRF protection). */
const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // includes cloud metadata at 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

export const isPrivateAddress = (address: string) => {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return privateRanges.check(mapped, "ipv4");
  const family = isIP(address);
  if (family === 0) return true;
  return privateRanges.check(address, family === 4 ? "ipv4" : "ipv6");
};

class BlockedAddressError extends Error {
  override name = "BlockedAddressError";
}

/**
 * A DNS lookup that refuses private addresses. Checking inside the socket's
 * own lookup (not before the request) means a hostname can't resolve to a
 * public IP for the check and a private one for the connection.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    const done = callback as (
      err: Error | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;
    if (err) return done(err, "");
    const list = addresses as LookupAddress[];
    const blocked = list.find((entry) => isPrivateAddress(entry.address));
    if (blocked || list.length === 0) {
      return done(
        new BlockedAddressError(`${hostname} resolves to a non-public address`),
        "",
      );
    }
    if (options.all) return done(null, list);
    return done(null, list[0]!.address, list[0]!.family);
  });
};

export type DeliveryResult =
  | { ok: true; statusCode: number }
  | { ok: false; statusCode?: number; error: string };

/**
 * POSTs a webhook. Never throws: a non-2xx status, a timeout or a network
 * error comes back as `ok: false`. Redirects are not followed, so a merchant
 * URL can't bounce the request somewhere else.
 */
export const postWebhook = (
  url: string,
  body: string,
  headers: Record<string, string>,
  {
    timeoutMs = 10_000,
    allowPrivateAddresses = false,
  }: { timeoutMs?: number; allowPrivateAddresses?: boolean } = {},
): Promise<DeliveryResult> =>
  new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return resolve({ ok: false, error: "Invalid URL" });
    }

    // An IP literal skips DNS, so the lookup hook never sees it.
    const literal = target.hostname.replace(/^\[|\]$/g, "");
    if (
      !allowPrivateAddresses &&
      isIP(literal) !== 0 &&
      isPrivateAddress(literal)
    ) {
      return resolve({
        ok: false,
        error: `${literal} is a non-public address`,
      });
    }

    const client = target.protocol === "https:" ? https : http;
    const request = client.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "PayBridge-Webhooks/1",
          ...headers,
        },
        ...(!allowPrivateAddresses && { lookup: publicOnlyLookup }),
      },
      (response) => {
        // Drain and ignore the body; only the status matters.
        response.resume();
        response.on("end", () => {
          clearTimeout(timer);
          const statusCode = response.statusCode ?? 0;
          resolve(
            statusCode >= 200 && statusCode < 300
              ? { ok: true, statusCode }
              : { ok: false, statusCode, error: `HTTP ${statusCode}` },
          );
        });
        response.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            ok: false,
            statusCode: response.statusCode,
            error: err.message,
          });
        });
      },
    );

    // Covers a slow connect, slow headers and a body that never ends. The
    // promise settles once, so whichever of these fires first wins.
    const timer = setTimeout(() => {
      const error = `Timed out after ${timeoutMs} ms`;
      request.destroy(new Error(error));
      resolve({ ok: false, error });
    }, timeoutMs);
    request.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    request.end(body);
  });
