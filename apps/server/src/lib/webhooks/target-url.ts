import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { RuntimeError } from "@mdcms/shared";

export type WebhookTargetAddressResolver = (
  hostname: string,
) => Promise<string[]>;

export type WebhookTargetValidationOptions = {
  resolveAddresses?: WebhookTargetAddressResolver;
};

export type ResolvedWebhookTarget = {
  url: string;
  hostname: string;
  address: string;
  addressFamily: 4 | 6;
};

const forbiddenAddresses = new BlockList();

forbiddenAddresses.addSubnet("0.0.0.0", 8, "ipv4");
forbiddenAddresses.addSubnet("10.0.0.0", 8, "ipv4");
forbiddenAddresses.addSubnet("100.64.0.0", 10, "ipv4");
forbiddenAddresses.addSubnet("127.0.0.0", 8, "ipv4");
forbiddenAddresses.addSubnet("169.254.0.0", 16, "ipv4");
forbiddenAddresses.addSubnet("172.16.0.0", 12, "ipv4");
forbiddenAddresses.addSubnet("192.0.0.0", 24, "ipv4");
forbiddenAddresses.addSubnet("192.0.2.0", 24, "ipv4");
forbiddenAddresses.addSubnet("192.88.99.0", 24, "ipv4");
forbiddenAddresses.addSubnet("192.168.0.0", 16, "ipv4");
forbiddenAddresses.addSubnet("198.18.0.0", 15, "ipv4");
forbiddenAddresses.addSubnet("198.51.100.0", 24, "ipv4");
forbiddenAddresses.addSubnet("203.0.113.0", 24, "ipv4");
forbiddenAddresses.addSubnet("224.0.0.0", 4, "ipv4");
forbiddenAddresses.addSubnet("240.0.0.0", 4, "ipv4");
forbiddenAddresses.addAddress("255.255.255.255", "ipv4");
forbiddenAddresses.addAddress("::", "ipv6");
forbiddenAddresses.addAddress("::1", "ipv6");
forbiddenAddresses.addSubnet("fc00::", 7, "ipv6");
forbiddenAddresses.addSubnet("fe80::", 10, "ipv6");
forbiddenAddresses.addSubnet("ff00::", 8, "ipv6");
forbiddenAddresses.addSubnet("2001:db8::", 32, "ipv6");

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

function forbiddenTargetError(details: Record<string, unknown>): RuntimeError {
  return new RuntimeError({
    code: "WEBHOOK_TARGET_FORBIDDEN",
    message: "Webhook target host is not routable.",
    statusCode: 400,
    details: {
      field: "url",
      ...details,
    },
  });
}

function notHttpsError(): RuntimeError {
  return new RuntimeError({
    code: "WEBHOOK_URL_NOT_HTTPS",
    message: 'Field "url" must use the https scheme.',
    statusCode: 400,
    details: { field: "url" },
  });
}

function isForbiddenHostnameAlias(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  );
}

function isForbiddenAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);

  if (family === 0) {
    return false;
  }

  return forbiddenAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

function addressFamily(address: string): 4 | 6 {
  const family = isIP(normalizeHostname(address));

  if (family !== 4 && family !== 6) {
    throw forbiddenTargetError({
      address,
      reason: "resolved_address_invalid",
    });
  }

  return family;
}

async function resolveTargetAddresses(
  hostname: string,
  resolveAddresses: WebhookTargetAddressResolver,
): Promise<string[]> {
  try {
    return await resolveAddresses(hostname);
  } catch (error) {
    throw forbiddenTargetError({
      hostname,
      reason: "resolution_failed",
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function defaultResolveTargetAddresses(
  hostname: string,
): Promise<string[]> {
  const results = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  return results.map((result) => result.address);
}

export async function assertWebhookTargetAllowed(
  url: string,
  options: WebhookTargetValidationOptions = {},
): Promise<void> {
  await resolveWebhookTarget(url, options);
}

export async function resolveWebhookTarget(
  url: string,
  options: WebhookTargetValidationOptions = {},
): Promise<ResolvedWebhookTarget> {
  const parsed = new URL(url);

  if (parsed.protocol !== "https:") {
    throw notHttpsError();
  }

  const hostname = normalizeHostname(parsed.hostname);

  if (isForbiddenHostnameAlias(hostname)) {
    throw forbiddenTargetError({
      hostname,
      reason: "forbidden_hostname",
    });
  }

  const literalAddressFamily = isIP(hostname);

  if (literalAddressFamily !== 0) {
    if (isForbiddenAddress(hostname)) {
      throw forbiddenTargetError({
        hostname,
        address: hostname,
        reason: "forbidden_address",
      });
    }

    return {
      url: parsed.toString(),
      hostname,
      address: hostname,
      addressFamily: addressFamily(hostname),
    };
  }

  const addresses = await resolveTargetAddresses(
    hostname,
    options.resolveAddresses ?? defaultResolveTargetAddresses,
  );

  if (addresses.length === 0) {
    throw forbiddenTargetError({
      hostname,
      reason: "target_not_resolved",
    });
  }

  const invalidAddress = addresses.find(
    (address) => isIP(normalizeHostname(address)) === 0,
  );

  if (invalidAddress) {
    throw forbiddenTargetError({
      hostname,
      address: normalizeHostname(invalidAddress),
      reason: "resolved_address_invalid",
    });
  }

  const forbiddenAddress = addresses.find((address) =>
    isForbiddenAddress(address),
  );

  if (forbiddenAddress) {
    throw forbiddenTargetError({
      hostname,
      address: normalizeHostname(forbiddenAddress),
      reason: "resolved_forbidden_address",
    });
  }

  const selectedAddress = normalizeHostname(addresses[0]!);

  return {
    url: parsed.toString(),
    hostname,
    address: selectedAddress,
    addressFamily: addressFamily(selectedAddress),
  };
}
