// tests/remote.e2e.test.ts

import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProxyServer } from "../src/ProxyServer";

const REMOTE_RPC = "https://eth.llamarpc.com";
const PROXY_PORT = 4003;

let proxy: ProxyServer;

beforeAll(async () => {
	proxy = new ProxyServer(REMOTE_RPC, PROXY_PORT);
	await proxy.start();
});

afterAll(async () => {
	await proxy.stop();
});

describe("ProxyServer - Remote RPC e2e", () => {
	it("should be able to get the block number from a remote RPC", async () => {
		const request = supertest(`http://127.0.0.1:${PROXY_PORT}`);
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty("result");
		expect(typeof res.body.result).toBe("string");
		const blockNumberHex = res.body.result;
		expect(typeof blockNumberHex).toBe("string");
		const blockNumber = Number(blockNumberHex);
		expect(blockNumber).toBeGreaterThanOrEqual(0);
	});
});
