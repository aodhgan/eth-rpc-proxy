// tests/anvil.viem.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { ProxyServer, ProxyMode } from "../src/ProxyServer";

const ANVIL_HOST = "127.0.0.1";
const ANVIL_PORT = 8555; // use a less-common port
const PROXY_PORT = 8556;

const ANVIL_HTTP = `http://${ANVIL_HOST}:${ANVIL_PORT}`;
const PROXY_HTTP = `http://${ANVIL_HOST}:${PROXY_PORT}`;

let anvil: ChildProcessWithoutNullStreams | undefined;
let proxy: ProxyServer | undefined;

async function waitForAnvilHealthy(url: string, timeoutMs = 25_000, intervalMs = 250) {
  const start = Date.now();
  // Use Viem client to poll chain id
  const client = createPublicClient({ chain: foundry, transport: http(url) });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await client.getChainId();
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error("Timed out waiting for anvil to be healthy");
      }
      await delay(intervalMs);
    }
  }
}

describe("E2E (Viem): ProxyServer ↔ Anvil deterministic forwarding", () => {
  beforeAll(async () => {
    // 1) Start anvil
    try {
      anvil = spawn("anvil", ["--host", ANVIL_HOST, "--port", String(ANVIL_PORT)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      // anvil not found — skip this file
      // eslint-disable-next-line no-console
      console.warn("⚠️  anvil not found in PATH; skipping e2e tests.", err?.message ?? err);
      // @ts-expect-error vitest global
      return vi.skip();
    }

    // Optional debugging:
    // anvil.stderr.on("data", (d) => process.stderr.write(`[anvil] ${String(d)}`));

    // 2) Wait until anvil responds
    await waitForAnvilHealthy(ANVIL_HTTP);

    // 3) Start proxy in deterministic mode (forwards by default)
    proxy = new ProxyServer(new URL(ANVIL_HTTP), PROXY_PORT);
    proxy.setDefaultMode(ProxyMode.Deterministic);
    await proxy.start();
  });

  afterAll(async () => {
    console.log("killing anvil..")
    await proxy?.stop?.();
    if (anvil) {
      anvil.kill("SIGINT");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        anvil?.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  });

  it("getChainId matches via proxy and direct (Viem)", async () => {
    const direct = createPublicClient({ chain: foundry, transport: http(ANVIL_HTTP) });
    const viaProxy = createPublicClient({ chain: foundry, transport: http(PROXY_HTTP) });

    const [idDirect, idProxy] = await Promise.all([
      direct.getChainId(),
      viaProxy.getChainId(),
    ]);

    console.log(    idProxy)

    expect(idProxy).toBe(idDirect);
    // Foundry default is 31337, but we just assert equality.
    expect(typeof idProxy).toBe("number");
  });

  it("getBlockNumber & getBlock('latest') work via proxy (Viem)", async () => {
    const direct = createPublicClient({ chain: foundry, transport: http(ANVIL_HTTP) });
    const viaProxy = createPublicClient({ chain: foundry, transport: http(PROXY_HTTP) });

    const [bnDirect, bnProxy] = await Promise.all([
      direct.getBlockNumber(),
      viaProxy.getBlockNumber(),
    ]);

    expect(bnProxy).toBeTypeOf("bigint");
    expect(bnDirect).toBeTypeOf("bigint");
    expect(bnProxy >= 0n).toBe(true);
    // Usually equal, but allow bnProxy >= bnDirect in case a block advanced between calls
    expect(bnProxy >= bnDirect).toBe(true);

    const block = await viaProxy.getBlock({ blockNumber: bnProxy });
    expect(block).toBeTruthy();
    expect(block.number).toBe(bnProxy);
    expect(block.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });
});
