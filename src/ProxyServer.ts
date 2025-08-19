import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { Server as HttpsServer } from "node:https";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { WSContext } from "hono/ws";
import type WebSocketLib from "ws"; // the 'ws' WebSocket type
import NodeWS from "ws";
import type { TaggedLogger } from "./utils/logger";
import { waitForCondition } from "./utils/waitForCondition";

const WebSocketImpl: typeof NodeWS =
	(globalThis as any).WebSocket ?? (NodeWS as unknown as typeof NodeWS);

export enum ProxyBehavior {
	Forward = "Forward",
	NotAnswer = "NotAnswer",
	Fail = "Fail",
}

export enum ProxyMode {
	Deterministic = "Deterministic",
	Random = "Random",
}

type AnyServer = HttpServer | HttpsServer | Http2Server | Http2SecureServer;

// -------- rules --------
type MethodMatcher = string | RegExp | ((method: string) => boolean);

interface BehaviorRule {
	match: MethodMatcher;
	mode: ProxyMode;
	queue: ProxyBehavior[]; // used when Deterministic
	probs?: Record<ProxyBehavior, number>; // used when Random
}

function matches(m: MethodMatcher, method: string): boolean {
	if (typeof m === "string") return method === m;
	if (m instanceof RegExp) return m.test(method);
	return m(method);
}

type RuleConfig =
	| ProxyBehavior
	| {
			mode: ProxyMode.Deterministic;
			behaviors?: ProxyBehavior[];
	  }
	| {
			mode: ProxyMode.Random;
			probs: Record<ProxyBehavior, number>;
	  };

// -----------------------

export class ProxyServer {
	readonly #PROXY_PORT: number;
	readonly #UPSTREAM: URL;

	private app: Hono;
	private server?: AnyServer;
	private injectWebSocket?: (server: AnyServer) => void;

	// default/fallback behavior (when no rule matches)
	private defaultMode: ProxyMode = ProxyMode.Deterministic;
	private defaultQueue: ProxyBehavior[] = [];
	private defaultProbs?: Record<ProxyBehavior, number>;

	// per-method rules (first match wins)
	private rules: BehaviorRule[] = [];

	constructor(
		upstreamUrl: string | URL,
		proxyPort: number,
		private logger?: TaggedLogger,
	) {
		this.#UPSTREAM = upstreamUrl instanceof URL ? upstreamUrl : new URL(upstreamUrl);
		this.#PROXY_PORT = proxyPort;

		this.app = new Hono();
		this.app.use("*", cors());

		this.#setupWebsocketProxy();
		this.#setupHttpProxy();
	}

	get upstreamHttpUrl(): string {
		return this.#UPSTREAM.toString();
	}
	get upstreamWsUrl(): string {
		const wsProto = this.#UPSTREAM.protocol === "https:" ? "wss:" : "ws:";
		return `${wsProto}//${this.#UPSTREAM.host}${this.#UPSTREAM.pathname}${this.#UPSTREAM.search}`;
	}

	// ------- public API: defaults -------
	public setDefaultMode(mode: ProxyMode.Random, probs: Record<ProxyBehavior, number>): void;
	public setDefaultMode(mode: Exclude<ProxyMode, ProxyMode.Random>): void;
	public setDefaultMode(mode: ProxyMode, probs?: Record<ProxyBehavior, number>): void {
		this.defaultMode = mode;
		if (mode === ProxyMode.Random) {
			if (!probs) throw new Error("You must provide probs when mode is Random");
			const sum = (Object.values(probs) as number[]).reduce((a, b) => a + b, 0);
			if (Math.abs(sum - 1) > 1e-12) throw new Error("Probs must sum to 1");
			this.defaultProbs = probs;
		} else {
			this.defaultProbs = undefined;
		}
	}
	public addBehavior(behavior: ProxyBehavior): void {
		this.defaultQueue.push(behavior);
	}
	public clearDefaultQueue(): void {
		this.defaultQueue.length = 0;
	}

	// ------- public API: rules -------
	/** Unified rule add: supports shorthand or config. First matching rule wins. */
	public addRule(match: MethodMatcher, config: RuleConfig): void {
		let rule: BehaviorRule;

		if (typeof config === "string") {
			// shorthand: deterministic with one queued behavior
			rule = { match, mode: ProxyMode.Deterministic, queue: [config] };
		} else if (config.mode === ProxyMode.Deterministic) {
			rule = { match, mode: ProxyMode.Deterministic, queue: [...(config.behaviors ?? [])] };
		} else {
			// Random
			const sum = (Object.values(config.probs) as number[]).reduce((a, b) => a + b, 0);
			if (Math.abs(sum - 1) > 1e-12) throw new Error("Probs must sum to 1");
			rule = { match, mode: ProxyMode.Random, queue: [], probs: config.probs };
		}

		this.rules.push(rule);
	}

	/** Push another deterministic behavior onto an existing deterministic rule’s queue. */
	public pushRuleBehavior(match: MethodMatcher, behavior: ProxyBehavior): void {
		const rule = this.rules.find(
			(r) => r.mode === ProxyMode.Deterministic && r.match === match,
		);
		if (!rule) throw new Error("No deterministic rule found for provided matcher");
		rule.queue.push(behavior);
	}

	public clearRules(): void {
		this.rules.length = 0;
	}

	// ------- lifecycle -------
	public async start(): Promise<void> {
		this.server = serve({ fetch: this.app.fetch, port: this.#PROXY_PORT }) as AnyServer;
		this.injectWebSocket?.(this.server);
	}
	public async stop(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			if (!this.server) return resolve();
			(this.server as any).close((err?: unknown) => (err ? reject(err) : resolve()));
		});
	}

	// ------- behavior selection/execution -------
	private pickRule(method: string): BehaviorRule | null {
		for (const r of this.rules) if (matches(r.match, method)) return r;
		return null;
	}

	private getBehavior(method: string): ProxyBehavior {
		const rule = this.pickRule(method);
		if (rule) {
			if (rule.mode === ProxyMode.Random) {
				const r = Math.random();
				const pNA = rule.probs?.[ProxyBehavior.NotAnswer] ?? 0;
				const pFail = rule.probs?.[ProxyBehavior.Fail] ?? 0;
				if (r < pNA) return ProxyBehavior.NotAnswer;
				if (r < pNA + pFail) return ProxyBehavior.Fail;
				return ProxyBehavior.Forward;
			} else {
				return rule.queue.shift() ?? ProxyBehavior.Forward;
			}
		}

		if (this.defaultMode === ProxyMode.Random) {
			const r = Math.random();
			const pNA = this.defaultProbs?.[ProxyBehavior.NotAnswer] ?? 0;
			const pFail = this.defaultProbs?.[ProxyBehavior.Fail] ?? 0;
			if (r < pNA) return ProxyBehavior.NotAnswer;
			if (r < pNA + pFail) return ProxyBehavior.Fail;
			return ProxyBehavior.Forward;
		} else {
			return this.defaultQueue.shift() ?? ProxyBehavior.Forward;
		}
	}

	private handleBehaviorHttp(c: Context, behavior: ProxyBehavior): Response | null {
		switch (behavior) {
			case ProxyBehavior.NotAnswer: {
				// Send headers and never finish body — client hangs on body read.
				const neverEndingBody = new ReadableStream<Uint8Array>({});
				return new Response(neverEndingBody, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			case ProxyBehavior.Fail:
				return c.json({ error: "Proxy error" }, 500);
			case ProxyBehavior.Forward:
			default:
				return null;
		}
	}

	private handleBehaviorWs(
		behavior: ProxyBehavior,
		parsed: any,
		appClient: WSContext<WebSocketLib>,
	): boolean {
		switch (behavior) {
			case ProxyBehavior.NotAnswer:
				// swallow: no forward, no response
				return true;
			case ProxyBehavior.Fail:
				appClient.send(
					JSON.stringify({
						id: parsed.id,
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal error - Proxy Denied" },
					}),
				);
				return true;
			case ProxyBehavior.Forward:
			default:
				return false;
		}
	}

	// ------- routes -------
	#setupWebsocketProxy(): void {
		const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: this.app });
		this.injectWebSocket = injectWebSocket;

		this.app.get(
			"*",
			upgradeWebSocket((_c) => {
				const upstream = new WebSocketImpl(this.upstreamWsUrl);
				const requestIdMap = new Map<number | string, { data: any; start: number }>();

				return {
					onMessage: (msg, appClient) => {
						const parsed = JSON.parse(msg.data.toString());
						const behavior = this.getBehavior(parsed.method);

						const handled = this.handleBehaviorWs(behavior, parsed, appClient);
						if (handled) return;

						requestIdMap.set(parsed.id, { data: parsed, start: performance.now() });

						waitForCondition(
							() => upstream.readyState === WebSocketImpl.OPEN,
							1000,
							100,
						)
							.then(() => upstream.send(msg.data as never))
							.catch(() =>
								this.logger?.error(
									"Upstream WS is not open; cannot forward message from Proxy WS server",
								),
							);
					},

					onClose: () => upstream.close(),

					onOpen: (_evt, appClient) => {
						upstream.addEventListener("message", (msg) => {
							const parsed = JSON.parse(msg.data.toString());
							const cached = requestIdMap.get(parsed.id);
							if (cached) {
								const ms =
									Math.round((performance.now() - cached.start) * 1000) / 1000;
								this.logger?.trace(
									`(websocket) ${ms.toString().padEnd(8, "0")}ms => ${cached.data.method}`,
								);
								requestIdMap.delete(parsed.id);
							}

							waitForCondition(
								() => appClient.readyState === WebSocketImpl.OPEN,
								1000,
								100,
							)
								.then(() => appClient.send(msg.data))
								.catch(() =>
									this.logger?.error(
										"Proxy WS client is not open; cannot forward responses from upstream",
									),
								);
						});

						upstream.addEventListener("close", () => appClient.close());
					},
				};
			}),
		);
	}

	#setupHttpProxy(): void {
		this.app.post("*", async (c) => {
			const body = await c.req.json();
			const behavior = this.getBehavior(body.method);

			const maybe = this.handleBehaviorHttp(c, behavior);
			if (maybe) return maybe;

			// Forward
			const incoming = new URL(c.req.url);
			const targetUrl = new URL(incoming.pathname + incoming.search, this.#UPSTREAM);

			try {
				const start = performance.now();
				const resp = await fetch(targetUrl.toString(), {
					method: c.req.method,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const data = await resp.json();
				const ms = Math.round((performance.now() - start) * 1000) / 1000;
				this.logger?.trace(`(http) ${ms.toString().padEnd(8, "0")}ms => ${body.method}`);
				return c.json(data, resp.status as ContentfulStatusCode);
			} catch (error) {
				return c.json({ error: `Proxy error: ${JSON.stringify(error)}` }, 500);
			}
		});
	}
}
