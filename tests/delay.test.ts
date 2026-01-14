import { createServer } from "node:http";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ProxyServer } from "../src/ProxyServer";

let upstreamHttp: ReturnType<typeof createServer>;
let upstreamWs: WebSocketServer;
let proxy: ProxyServer;

const UPSTREAM = new URL("http://127.0.0.1:4011");
const PROXY_PORT = 4012;
const PROXY_HTTP_URL = `http://127.0.0.1:${PROXY_PORT}`;

beforeAll(async () => {
	upstreamHttp = createServer((req, res) => {
		if (req.method === "POST") {
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

	upstreamWs = new WebSocketServer({ server: upstreamHttp });
	upstreamWs.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			socket.send(
				JSON.stringify({
					id: msg.id,
					jsonrpc: "2.0",
					result: "ok-ws",
				}),
			);
		});
	});

	proxy = new ProxyServer(UPSTREAM.toString(), PROXY_PORT);
	await proxy.start();
});

afterAll(async () => {
	await proxy.stop();
	await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
	await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
}, 15000);

beforeEach(() => {
	proxy.setPreDelay(0);
	proxy.setPostDelay(0);
});

describe("ProxyServer - Delay functionality", () => {
	it("pre-delay adds expected latency to HTTP request", async () => {
		const delayMs = 100;
		proxy.setPreDelay(delayMs);

		const request = supertest(PROXY_HTTP_URL);
		const start = performance.now();
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
		const elapsed = performance.now() - start;

		expect(res.status).toBe(200);
		expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
	});

	it("post-delay adds expected latency to HTTP response", async () => {
		const delayMs = 100;
		proxy.setPostDelay(delayMs);

		const request = supertest(PROXY_HTTP_URL);
		const start = performance.now();
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
		const elapsed = performance.now() - start;

		expect(res.status).toBe(200);
		expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
	});

	it("combined delays work correctly for HTTP", async () => {
		const preDelayMs = 50;
		const postDelayMs = 50;
		proxy.setPreDelay(preDelayMs);
		proxy.setPostDelay(postDelayMs);

		const request = supertest(PROXY_HTTP_URL);
		const start = performance.now();
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
		const elapsed = performance.now() - start;

		expect(res.status).toBe(200);
		expect(elapsed).toBeGreaterThanOrEqual(preDelayMs + postDelayMs - 15);
	});

	it("pre-delay adds expected latency to WebSocket request", async () => {
		const delayMs = 100;
		proxy.setPreDelay(delayMs);

		const client = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/`);

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS open timeout")), 3000);
			client.once("open", () => {
				clearTimeout(timer);
				resolve();
			});
			client.once("error", reject);
		});

		const start = performance.now();
		client.send(
			JSON.stringify({
				id: 42,
				jsonrpc: "2.0",
				method: "eth_blockNumber",
				params: [],
			}),
		);

		const response = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS message timeout")), 5000);
			client.once("message", (raw) => {
				clearTimeout(timer);
				resolve(JSON.parse(raw.toString()));
			});
			client.once("error", reject);
		});
		const elapsed = performance.now() - start;

		expect(response).toEqual({ id: 42, jsonrpc: "2.0", result: "ok-ws" });
		expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);

		await new Promise<void>((resolve) => {
			client.close();
			client.once("close", () => resolve());
		});
	});

	it("post-delay adds expected latency to WebSocket response", async () => {
		const delayMs = 100;
		proxy.setPostDelay(delayMs);

		const client = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/`);

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS open timeout")), 3000);
			client.once("open", () => {
				clearTimeout(timer);
				resolve();
			});
			client.once("error", reject);
		});

		const start = performance.now();
		client.send(
			JSON.stringify({
				id: 43,
				jsonrpc: "2.0",
				method: "eth_blockNumber",
				params: [],
			}),
		);

		const response = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS message timeout")), 5000);
			client.once("message", (raw) => {
				clearTimeout(timer);
				resolve(JSON.parse(raw.toString()));
			});
			client.once("error", reject);
		});
		const elapsed = performance.now() - start;

		expect(response).toEqual({ id: 43, jsonrpc: "2.0", result: "ok-ws" });
		expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);

		await new Promise<void>((resolve) => {
			client.close();
			client.once("close", () => resolve());
		});
	});

	it("combined delays work correctly for WebSocket", async () => {
		const preDelayMs = 50;
		const postDelayMs = 50;
		proxy.setPreDelay(preDelayMs);
		proxy.setPostDelay(postDelayMs);

		const client = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/`);

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS open timeout")), 3000);
			client.once("open", () => {
				clearTimeout(timer);
				resolve();
			});
			client.once("error", reject);
		});

		const start = performance.now();
		client.send(
			JSON.stringify({
				id: 44,
				jsonrpc: "2.0",
				method: "eth_blockNumber",
				params: [],
			}),
		);

		const response = await new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS message timeout")), 5000);
			client.once("message", (raw) => {
				clearTimeout(timer);
				resolve(JSON.parse(raw.toString()));
			});
			client.once("error", reject);
		});
		const elapsed = performance.now() - start;

		expect(response).toEqual({ id: 44, jsonrpc: "2.0", result: "ok-ws" });
		expect(elapsed).toBeGreaterThanOrEqual(preDelayMs + postDelayMs - 15);

		await new Promise<void>((resolve) => {
			client.close();
			client.once("close", () => resolve());
		});
	});

	it("setting delay to 0 disables it", async () => {
		proxy.setPreDelay(100);
		proxy.setPostDelay(100);
		proxy.setPreDelay(0);
		proxy.setPostDelay(0);

		const request = supertest(PROXY_HTTP_URL);
		const start = performance.now();
		const res = await request
			.post("/")
			.set("Content-Type", "application/json")
			.send({ id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
		const elapsed = performance.now() - start;

		expect(res.status).toBe(200);
		expect(elapsed).toBeLessThan(50);
	});
});
