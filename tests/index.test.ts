import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { ProxyServer, ProxyMode } from "../src/ProxyServer";

// Mock upstream (anvil) server for testing
import { createServer } from "http";

let upstreamServer: ReturnType<typeof createServer>;
let proxy: ProxyServer;
let request: supertest.SuperTest<supertest.Test>;

const ANVIL_PORT = 4001;
const PROXY_PORT = 4002;

beforeAll(async () => {
  // 1. Start fake upstream (anvil) server
  upstreamServer = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        // Echo back result for testing
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: parsed.id, result: "ok" }));
      });
    }
  });
  await new Promise<void>((resolve) => upstreamServer.listen(ANVIL_PORT, resolve));

  // 2. Start proxy
  proxy = new ProxyServer(ANVIL_PORT, PROXY_PORT);
  await proxy.start();

  // 3. Supertest client for proxy
  request = supertest(`http://localhost:${PROXY_PORT}`);
});

afterAll(async () => {
  upstreamServer.close();
  // no stop method in ProxyServer yet, so rely on process exit
});

describe("ProxyServer (forward mode)", () => {
  it("forwards a basic JSON-RPC request", async () => {
    const response = await request
      .post("/")
      .send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] })
      .set("Content-Type", "application/json");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 1, result: "ok" });
  });
});