import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { isPrivateIPv4, lanAddresses, lanUrls } from "../../../scripts/lib/lan.mjs";

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

const v6 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: "ffff:ffff:ffff:ffff::",
  family: "IPv6",
  mac: "00:00:00:00:00:00",
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0,
});

describe("lanAddresses", () => {
  it("keeps the real Wi-Fi and Ethernet addresses", () => {
    const list = lanAddresses({
      "Wi-Fi": [v6("fe80::1"), v4("192.168.1.101")],
      Ethernet: [v4("10.0.0.5")],
    });
    expect(list.map((a: { address: string }) => a.address).sort()).toEqual(["10.0.0.5", "192.168.1.101"]);
  });

  it("skips loopback, link-local (no address from the router) and internal entries", () => {
    const list = lanAddresses({
      "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)],
      "Wi-Fi": [v4("169.254.10.20")],
      Other: [v4("192.168.5.5", true)],
    });
    expect(list).toEqual([]);
  });

  it("skips virtual machine, WSL, VPN and Bluetooth adapters", () => {
    const list = lanAddresses({
      "vEthernet (WSL (Hyper-V firewall))": [v4("172.20.48.1")],
      "VirtualBox Host-Only Network": [v4("192.168.56.1")],
      "VMware Network Adapter VMnet8": [v4("192.168.200.1")],
      Tailscale: [v4("100.101.102.103")],
      "Bluetooth Network Connection": [v4("192.168.44.1")],
      "Wi-Fi": [v4("192.168.1.101")],
    });
    expect(list).toEqual([{ address: "192.168.1.101", name: "Wi-Fi" }]);
  });

  it("skips the 100.64.0.0/10 range used by VPNs and carrier NAT", () => {
    expect(lanAddresses({ Ethernet: [v4("100.64.1.1"), v4("100.127.255.1")] })).toEqual([]);
  });

  it("accepts Node's numeric family (4) and removes duplicates", () => {
    const numeric = { ...v4("192.168.1.9"), family: 4 } as unknown as NetworkInterfaceInfo;
    expect(lanAddresses({ "Wi-Fi": [numeric, v4("192.168.1.9")] })).toEqual([{ address: "192.168.1.9", name: "Wi-Fi" }]);
  });

  it("puts private addresses first", () => {
    const list = lanAddresses({ Ethernet: [v4("203.0.113.7")], "Wi-Fi": [v4("192.168.1.101")] });
    expect(list.map((a: { address: string }) => a.address)).toEqual(["192.168.1.101", "203.0.113.7"]);
  });

  it("copes with an empty or missing list", () => {
    expect(lanAddresses({})).toEqual([]);
    expect(lanAddresses({ "Wi-Fi": undefined })).toEqual([]);
  });
});

describe("lanUrls", () => {
  it("builds http://<address>:<port>", () => {
    expect(lanUrls(3000, { "Wi-Fi": [v4("192.168.1.101")] })).toEqual([
      { address: "192.168.1.101", name: "Wi-Fi", url: "http://192.168.1.101:3000" },
    ]);
  });
});

describe("isPrivateIPv4", () => {
  it("knows the three private ranges", () => {
    expect(isPrivateIPv4("10.1.2.3")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.1")).toBe(true);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false);
    expect(isPrivateIPv4("192.168.0.1")).toBe(true);
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("not an ip")).toBe(false);
  });
});
