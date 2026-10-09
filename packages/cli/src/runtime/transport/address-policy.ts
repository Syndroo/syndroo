import { BlockList, isIP } from "node:net";

// Conservative policy: deny all IANA special-purpose allocations, including
// globally reachable special services. Do not treat NAT64/6to4 as plain unicast.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const denied4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) denied4.addSubnet(address, prefix, "ipv4");

const unicast6 = new BlockList();
unicast6.addSubnet("2000::", 3, "ipv6");
const denied6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["2620:4f:8000::", 48], ["3fff::", 20],
] as const) denied6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !denied4.check(address, "ipv4");
  return family === 6 && unicast6.check(address, "ipv6") && !denied6.check(address, "ipv6");
}

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  return isIP(address) === 6 && !address.includes("%") && addressKey(address) === "[::1]";
}

/** URL canonicalization makes equivalent IPv6 spellings compare identically. */
export function addressKey(address: string): string {
  if (isIP(address) === 4) return address;
  if (isIP(address) === 6 && !address.includes("%")) return new URL(`http://[${address}]`).hostname;
  return "";
}
