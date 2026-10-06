// The PC's addresses on the office network, for "open http://<address>:3000 on another computer".
import os from "node:os";

/** Network adapters that are not the office network (virtual machines, VPNs, Bluetooth…). */
export const VIRTUAL_ADAPTER_RE =
  /(vethernet|virtualbox|vmware|hyper-v|\bwsl\b|docker|loopback|npcap|bluetooth|\btap-|tailscale|zerotier|hamachi|radmin|openvpn|wireguard|wintun|\bvpn\b|host-only)/i;

export function isPrivateIPv4(ip) {
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

function isIPv4Family(family) {
  return family === "IPv4" || family === 4;
}

/**
 * IPv4 addresses other office computers can use, from os.networkInterfaces() output.
 * Skips internal (127.x), link-local (169.254.x, "no address from the router"), carrier-grade
 * NAT / VPN ranges (100.64.0.0/10) and virtual adapters. Private addresses come first.
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  const seen = new Set();
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    if (VIRTUAL_ADAPTER_RE.test(name)) continue;
    for (const a of list ?? []) {
      if (!a || !isIPv4Family(a.family) || a.internal) continue;
      const ip = a.address;
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      const [x, y] = ip.split(".").map(Number);
      if (x === 100 && y >= 64 && y <= 127) continue;
      if (seen.has(ip)) continue;
      seen.add(ip);
      out.push({ address: ip, name });
    }
  }
  return out.sort((a, b) => Number(isPrivateIPv4(b.address)) - Number(isPrivateIPv4(a.address)));
}

export function lanUrls(port, interfaces) {
  return lanAddresses(interfaces).map((a) => ({ ...a, url: `http://${a.address}:${port}` }));
}
