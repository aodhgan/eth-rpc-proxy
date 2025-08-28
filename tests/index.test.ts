// tests/index.test.ts

import { createServer } from "node:http";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ProxyBehavior, ProxyMode, ProxyServer } from "../src/ProxyServer";

let upstreamHttp: ReturnType<typeof createServer>;
let upstreamWs: WebSocketServer;
let proxy: ProxyServer;

const UPSTREAM = new URL("http://127.0.0.1:4001");
const PROXY_PORT = 4002;
const PROXY_HTTP_URL = `http://127.0.0.1:${PROXY_PORT}`;

// track upstream POST hits so we can assert "not forwarded"
let upstreamReceived = 0;

beforeAll(async () => {
	// 1) Start upstream HTTP (needed so WS can attach to it)
	upstreamHttp = createServer((req, res) => {
		if (req.method === "POST") {
			upstreamReceived++;
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				const parsed = JSON.parse(body);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ id: parsed.id, result: "ok-http" }));
			});
		} else {
			res.writeHead(404).end();
		}
	});

	await new Promise<void>((resolve) =>
		upstreamHttp.listen(Number(UPSTREAM.port), UPSTREAM.hostname, resolve),
	);

	// 2) Attach a WS server to the same HTTP server
	upstreamWs = new WebSocketServer({ server: upstreamHttp });
	upstreamWs.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			// Echo a JSON-RPC-like response
			socket.send(
				JSON.stringify({
					id: msg.id,
					jsonrpc: "2.0",
					result: "ok-ws",
				}),
			);
		});
	});

	// 3) Start proxy
	proxy = new ProxyServer(UPSTREAM.toString(), PROXY_PORT);
	await proxy.start();
});

afterAll(async () => {
	await proxy.stop();
	await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
	await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
}, 15000);

// Reset proxy behavior state before each test to avoid leakage
beforeEach(() => {
	proxy.clearRules();
	proxy.clearDefaultQueue();
	proxy.setDefaultMode(ProxyMode.Deterministic); // baseline: forward
});

describe("ProxyServer - WebSocket + HTTP forwarding & behaviors", () => {
	it("forwards WS messages and returns upstream responses", async () => {
		const client = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/`);

		// Open connection
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS open timeout")), 3000);
			client.once("open", () => {
				clearTimeout(timer);
				resolve();
			});
			client.once("error", reject);
		});

		// Send a JSON-RPC request through the proxy
		client.send(
			JSON.stringify({
				id: 42,
				jsonrpc: "2.0",
				method: "eth_blockNumber",
				params: [],
			}),
		);

		// Wait for the proxied response
		const response = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS message timeout")), 3000);
			client.once("message", (raw) => {
				clearTimeout(timer);
				resolve(JSON.parse(raw.toString()));
			});
			client.once("error", reject);
		});

		expect(response).toEqual({ id: 42, jsonrpc: "2.0", result: "ok-ws" });

		// Cleanup
		await new Promise<void>((resolve) => {
			client.close();
			client.once("close", () => resolve());
		});
	});

	it("still forwards HTTP POSTs while WS is attached", async () => {
		const request = supertest(PROXY_HTTP_URL);
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ id: 1, result: "ok-http" });
	});

	it("does not forward (HTTP) when ProxyBehavior.NotAnswer is queued – body never finishes", async () => {
		const before = upstreamReceived;

		// Queue: next deterministic call should 'hang' (headers then never-ending body)
		proxy.addBehavior(ProxyBehavior.NotAnswer);

		const ac = new AbortController();

		// fetch resolves after headers; the 'hang' occurs when reading the body
		const res = await fetch(PROXY_HTTP_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: 123,
				jsonrpc: "2.0",
				method: "eth_sendRawTransaction",
				params: ["0xdeadbeef"],
			}),
			signal: ac.signal,
		});

		// Now attempt to read the body; this should hang until we abort
		let aborted = false;
		const timer = setTimeout(() => ac.abort(), 600);
		try {
			const reader = res.body!.getReader();
			await reader.read(); // hangs until abort
		} catch (e: any) {
			aborted = e?.name === "AbortError";
		} finally {
			clearTimeout(timer);
		}

		expect(aborted).toBe(true);
		expect(upstreamReceived).toBe(before); // not forwarded
	});

	it("does not forward (WS) when ProxyBehavior.NotAnswer is queued – no response comes back", async () => {
		// Queue: next deterministic call should be swallowed
		proxy.addBehavior(ProxyBehavior.NotAnswer);

		const client = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/`);

		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("WS open timeout")), 2000);
			client.once("open", () => {
				clearTimeout(t);
				resolve();
			});
			client.once("error", reject);
		});

		client.send(
			JSON.stringify({
				id: 999,
				jsonrpc: "2.0",
				method: "eth_sendRawTransaction",
				params: ["0xfeedface"],
			}),
		);

		const gotMessage = await new Promise<boolean>((resolve) => {
			const t = setTimeout(() => resolve(false), 600); // we expect no message
			client.once("message", () => {
				clearTimeout(t);
				resolve(true);
			});
		});

		expect(gotMessage).toBe(false);

		await new Promise<void>((resolve) => {
			client.close();
			client.once("close", () => resolve());
		});
	});

	it("fails only for eth_sendRawTransaction, forwards other methods", async () => {
		// Rule: only eth_sendRawTransaction should fail.
		// Deterministic rules consume one behavior per match, so queue two:
		// one for HTTP and one for WS.
		proxy.addRule("eth_sendRawTransaction", {
			mode: ProxyMode.Deterministic,
			behaviors: [ProxyBehavior.Fail, ProxyBehavior.Fail],
		});

		// HTTP: sendRawTransaction should fail
		const request = supertest(PROXY_HTTP_URL);
		const failRes = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({
				id: 1,
				jsonrpc: "2.0",
				method: "eth_sendRawTransaction",
				params: ["0xdead"],
			});

		expect(failRes.status).toBe(500);
		expect(failRes.body).toHaveProperty("error");

		// HTTP: blockNumber should still forward
		const okRes = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 2, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(okRes.status).toBe(200);
		expect(okRes.body).toEqual({ id: 2, result: "ok-http" });

		// WS: sendRawTransaction should fail (consumes the second Fail)
		const client = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/`);
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		client.send(
			JSON.stringify({
				id: 100,
				jsonrpc: "2.0",
				method: "eth_sendRawTransaction",
				params: ["0xdead"],
			}),
		);

		const wsFail = await new Promise<any>((resolve, reject) => {
			client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
			client.once("error", reject);
		});

		expect(wsFail).toMatchObject({
			id: 100,
			jsonrpc: "2.0",
			error: { message: expect.stringContaining("Proxy Denied") },
		});

		// WS: blockNumber should succeed
		client.send(
			JSON.stringify({
				id: 101,
				jsonrpc: "2.0",
				method: "eth_blockNumber",
				params: [],
			}),
		);

		const wsOk = await new Promise<any>((resolve, reject) => {
			client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
			client.once("error", reject);
		});

		expect(wsOk).toEqual({ id: 101, jsonrpc: "2.0", result: "ok-ws" });

		client.close();
	});
});

describe("ProxyServer rule management", () => {
	it("adds and respects a simple string-based rule", async () => {
		proxy.addRule("eth_blockNumber", ProxyBehavior.Fail);

		const request = supertest(PROXY_HTTP_URL);
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(res.status).toBe(500);

		// other methods should still be forwarded
		const okRes = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 2, jsonrpc: "2.0", method: "eth_chainId", params: [] });

		expect(okRes.status).toBe(200);
	});

	it("adds and respects a RegExp-based rule", async () => {
		proxy.addRule(/^eth_/, ProxyBehavior.Fail);

		const request = supertest(PROXY_HTTP_URL);
		const res1 = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(res1.status).toBe(500);

		proxy.clearRules();

		const res2 = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 2, jsonrpc: "2.0", method: "eth_chainId", params: [] });

		expect(res2.status).toBe(200);
	});

	it("adds and respects a function-based rule", async () => {
		proxy.addRule((method) => method.includes("block"), ProxyBehavior.Fail);

		const request = supertest(PROXY_HTTP_URL);
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(res.status).toBe(500);
	});

	it("pushes behavior to an existing deterministic rule", async () => {
		const match = /^eth_blockNumber$/;
		proxy.addRule(match, ProxyBehavior.Fail);
		proxy.pushRuleBehavior(match, ProxyBehavior.NotAnswer);

		const request = supertest(PROXY_HTTP_URL);
		const res1 = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(res1.status).toBe(500);

		const ac = new AbortController();
		const res2 = await fetch(PROXY_HTTP_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "eth_blockNumber", params: [] }),
			signal: ac.signal,
		});

		let aborted = false;
		const timer = setTimeout(() => ac.abort(), 600);
		try {
			await res2.text();
		} catch (e: any) {
			aborted = e?.name === "AbortError";
		} finally {
			clearTimeout(timer);
		}
		expect(aborted).toBe(true);
	});

	it("clears all rules", async () => {
		proxy.addRule("eth_blockNumber", ProxyBehavior.Fail);
		proxy.clearRules();

		const request = supertest(PROXY_HTTP_URL);
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });

		expect(res.status).toBe(200);
	});

	it("respects random rule probabilities", async () => {
		proxy.clearRules();
		const probs = {
			[ProxyBehavior.Forward]: 0.5,
			[ProxyBehavior.NotAnswer]: 0.3,
			[ProxyBehavior.Fail]: 0.2,
		};
		proxy.addRule("eth_blockNumber", {
			mode: ProxyMode.Random,
			probs,
		});

		const results = {
			[ProxyBehavior.Forward]: 0,
			[ProxyBehavior.NotAnswer]: 0,
			[ProxyBehavior.Fail]: 0,
		};

		const totalRequests = 20;
		for (let i = 0; i < totalRequests; i++) {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 2000);

			try {
				const res = await fetch(PROXY_HTTP_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: i,
						jsonrpc: "2.0",
						method: "eth_blockNumber",
						params: [],
					}),
					signal: ac.signal,
				});

				await res.text();

				if (res.status === 200) {
					results[ProxyBehavior.Forward]++;
				} else if (res.status === 500) {
					results[ProxyBehavior.Fail]++;
				}
			} catch (err: any) {
				if (err.name === "AbortError") {
					results[ProxyBehavior.NotAnswer]++;
				} else {
					throw err;
				}
			} finally {
				clearTimeout(timer);
			}
		}
		expect(results[ProxyBehavior.Forward]).toBeGreaterThan(4);
		expect(results[ProxyBehavior.NotAnswer]).toBeGreaterThan(1);
		expect(results[ProxyBehavior.Fail]).toBeGreaterThan(0);

		const sum =
			results[ProxyBehavior.Forward] +
			results[ProxyBehavior.NotAnswer] +
			results[ProxyBehavior.Fail];
		expect(sum).toBe(totalRequests);
	}, 30000);
});
