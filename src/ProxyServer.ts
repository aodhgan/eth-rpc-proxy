import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Http2Server, Http2SecureServer } from "node:http2";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { WSContext } from "hono/ws";
import type WebSocketLib from "ws";
import NodeWS from "ws";
import type { TaggedLogger } from "./utils/logger";
import { waitForCondition } from "./utils/waitForCondition";
import { rawDataToUint8OrString, rawDataToString, truncateForLog, matches } from "./utils/helpers";
import { sleep } from "./utils/sleep";

// Prefer native WebSocket (workers), otherwise node 'ws'
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
export type MethodMatcher = string | RegExp | ((method: string) => boolean);

interface BehaviorRule {
	match: MethodMatcher;
	mode: ProxyMode;
	queue: ProxyBehavior[]; // used when Deterministic
	probs?: Record<ProxyBehavior, number>; // used when Random
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

	// delay configuration
	private preDelayMs: number = 0;
	private postDelayMs: number = 0;

	constructor(
		upstreamUrl: string | URL,
		proxyPort: number,
		private logger?: TaggedLogger,
		private logResponses: boolean = false,
	) {
		this.#UPSTREAM = upstreamUrl instanceof URL ? upstreamUrl : new URL(upstreamUrl);
		this.#PROXY_PORT = proxyPort;

		// Read delay configuration from environment
		const preDelayEnv = process.env.PROXY_PRE_DELAY_MS;
		if (preDelayEnv) {
			this.preDelayMs = Number.parseInt(preDelayEnv, 10) || 0;
		}
		const postDelayEnv = process.env.PROXY_POST_DELAY_MS;
		if (postDelayEnv) {
			this.postDelayMs = Number.parseInt(postDelayEnv, 10) || 0;
		}

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
			this.logger?.trace(`Default mode set: Random (probs=${JSON.stringify(probs)})`);
		} else {
			this.defaultProbs = undefined;
			this.logger?.trace("Default mode set: Deterministic");
		}
	}
	public addBehavior(behavior: ProxyBehavior): void {
		this.defaultQueue.push(behavior);
		this.logger?.trace(`Default queue +1 → [${this.defaultQueue.join(", ")}]`);
	}
	public clearDefaultQueue(): void {
		this.defaultQueue.length = 0;
		this.logger?.trace("Default queue cleared");
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

		const matcher =
			typeof match === "string" ? match : match instanceof RegExp ? match.toString() : "fn";
		if (rule.mode === ProxyMode.Random) {
			this.logger?.trace(
				`Rule added for ${matcher}: Random (probs=${JSON.stringify(rule.probs)})`,
			);
		} else {
			this.logger?.trace(
				`Rule added for ${matcher}: Deterministic queue=[${rule.queue.join(", ")}]`,
			);
		}
	}

	/** Push another deterministic behavior onto an existing deterministic rule’s queue. */
	public pushRuleBehavior(match: MethodMatcher, behavior: ProxyBehavior): void {
		const rule = this.rules.find(
			(r) => r.mode === ProxyMode.Deterministic && String(r.match) === String(match),
		);
		if (!rule) throw new Error("No deterministic rule found for provided matcher");
		rule.queue.push(behavior);

		const matcher =
			typeof match === "string" ? match : match instanceof RegExp ? match.toString() : "fn";
		this.logger?.trace(`Rule ${matcher}: +1 behavior → ${behavior}`);
	}

	public clearRules(): void {
		this.rules.length = 0;
		this.logger?.trace("All rules cleared");
	}

	// ------- public API: delay configuration -------
	public setPreDelay(ms: number): void {
		this.preDelayMs = ms;
		this.logger?.trace(`Pre-delay set: ${ms}ms`);
	}

	public setPostDelay(ms: number): void {
		this.postDelayMs = ms;
		this.logger?.trace(`Post-delay set: ${ms}ms`);
	}

	// ------- lifecycle -------
	public async start(): Promise<void> {
		this.server = serve({ fetch: this.app.fetch, port: this.#PROXY_PORT }) as AnyServer;
		this.logger?.info(`Proxy listening on :${this.#PROXY_PORT} → ${this.upstreamHttpUrl}`);
		if (this.preDelayMs > 0) {
			this.logger?.info(`Pre-delay: ${this.preDelayMs}ms`);
		}
		if (this.postDelayMs > 0) {
			this.logger?.info(`Post-delay: ${this.postDelayMs}ms`);
		}
		this.injectWebSocket?.(this.server);
	}
	public async stop(): Promise<void> {
		this.logger?.info("Stopping proxy…");
		await new Promise<void>((resolve, reject) => {
			if (!this.server) return resolve();
			(this.server as any).close((err?: unknown) => (err ? reject(err) : resolve()));
		});
		this.logger?.info("Proxy stopped.");
	}

	// ------- behavior selection/execution -------
	#pickRule(method: string): BehaviorRule | null {
		for (const r of this.rules) if (matches(r.match, method)) return r;
		return null;
	}

	#getBehavior(method: string): ProxyBehavior {
		const rule = this.#pickRule(method);
		if (rule) {
			if (rule.mode === ProxyMode.Random) {
				return this.#getBehaviorFromProbs(rule.probs);
			} else {
				return rule.queue.shift() ?? ProxyBehavior.Forward;
			}
		}

		if (this.defaultMode === ProxyMode.Random) {
			return this.#getBehaviorFromProbs(this.defaultProbs);
		} else {
			return this.defaultQueue.shift() ?? ProxyBehavior.Forward;
		}
	}

	#getBehaviorFromProbs(probs?: Record<ProxyBehavior, number>): ProxyBehavior {
		const r = Math.random();
		const pNA = probs?.[ProxyBehavior.NotAnswer] ?? 0;
		const pFail = probs?.[ProxyBehavior.Fail] ?? 0;
		if (r < pNA) return ProxyBehavior.NotAnswer;
		if (r < pNA + pFail) return ProxyBehavior.Fail;
		return ProxyBehavior.Forward;
	}

	#handleBehaviorHttp(c: Context, behavior: ProxyBehavior): Response | null {
		switch (behavior) {
			case ProxyBehavior.NotAnswer: {
				this.logger?.info("[http] ✋ NotAnswer (swallowing response)");
				// Send headers and never finish body — client hangs on body read.
				const neverEndingBody = new ReadableStream<Uint8Array>({});
				return new Response(neverEndingBody, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			case ProxyBehavior.Fail:
				this.logger?.info("[http] ❌ Fail — returning 500");
				return c.json({ error: "Proxy error" }, 500);
			default:
				return null;
		}
	}

	#handleBehaviorWs(
		behavior: ProxyBehavior,
		parsed: any,
		appClient: WSContext<WebSocketLib>,
	): boolean {
		switch (behavior) {
			case ProxyBehavior.NotAnswer:
				this.logger?.info("[ws] ✋ NotAnswer (not forwarding, no response)");
				return true; // swallow
			case ProxyBehavior.Fail:
				this.logger?.info("[ws] ❌ Fail — sending error frame");
				appClient.send(
					JSON.stringify({
						id: parsed.id,
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal error - Proxy Denied" },
					}),
				);
				return true;
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
				const requestIdMap = new Map<number | string, { method: string; start: number }>();

				return {
					onMessage: async (msg, appClient) => {
						const parsed = JSON.parse(msg.data.toString());
						const paramsStr = parsed.params ? ` ${JSON.stringify(parsed.params)}` : "";
						this.logger?.info(`[ws] -> ${parsed.method ?? "unknown"}${paramsStr}`);

						const behavior = this.#getBehavior(parsed.method);
						const handled = this.#handleBehaviorWs(behavior, parsed, appClient);
						if (handled) return;

						if (parsed.id != null) {
							requestIdMap.set(parsed.id, {
								method: parsed.method,
								start: performance.now(),
							});
							setTimeout(() => requestIdMap.delete(parsed.id), 30_000); // GC safeguard
						}

						// Apply pre-delay before forwarding
						if (this.preDelayMs > 0) {
							await sleep(this.preDelayMs);
						}

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

					onClose: () => {
						this.logger?.info("[ws] client disconnected");
						upstream.close();
					},

					onOpen: (_evt, appClient) => {
						this.logger?.info("[ws] client connected");

						upstream.addEventListener("message", async (raw) => {
							const text = rawDataToString((raw as any).data ?? raw);
							const parsed = JSON.parse(text);

							if (parsed.id != null) {
								const cached = requestIdMap.get(parsed.id);
								if (cached) {
									const ms =
										Math.round((performance.now() - cached.start) * 1000) /
										1000;
									const bodyLog = this.logResponses
										? ` <= ${truncateForLog(text)}`
										: "";
									this.logger?.trace(
										`(websocket) ${ms.toString().padEnd(8, "0")}ms => ${cached.method}${bodyLog}`,
									);
									requestIdMap.delete(parsed.id);
								} else if (this.logResponses) {
									// response with id we didn't initiate (rare), still log if requested
									this.logger?.trace(`[websocket] <= ${truncateForLog(text)}`);
								}
							} else if (this.logResponses) {
								// Notification (e.g., eth_subscription)
								this.logger?.trace(
									`[websocket] <= notification ${truncateForLog(text)}`,
								);
							}

							// Apply post-delay before sending response to client
							if (this.postDelayMs > 0) {
								await sleep(this.postDelayMs);
							}

							waitForCondition(
								() => appClient.readyState === WebSocketImpl.OPEN,
								1000,
								100,
							)
								.then(() =>
									appClient.send(
										rawDataToUint8OrString((raw as any).data ?? raw) as
											| string
											| ArrayBuffer
											| Uint8Array,
									),
								)
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
			const behavior = this.#getBehavior(body.method);

			// High-level request log
			this.logger?.info(
				`[http] -> ${body.method}${body.params ? " " + JSON.stringify(body.params) : ""}`,
			);

			const maybe = this.#handleBehaviorHttp(c, behavior);
			if (maybe) return maybe;

			// Apply pre-delay before forwarding
			if (this.preDelayMs > 0) {
				await sleep(this.preDelayMs);
			}

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

				const paramsStr = body.params ? ` ${JSON.stringify(body.params)}` : "";
				const responseLog = this.logResponses
					? ` <= ${truncateForLog(JSON.stringify(data))}`
					: "";

				this.logger?.trace(
					`(http) ${ms.toString().padEnd(8, "0")}ms => ${body.method}${paramsStr}${responseLog}`,
				);

				// Apply post-delay before sending response to client
				if (this.postDelayMs > 0) {
					await sleep(this.postDelayMs);
				}

				return c.json(data, resp.status as ContentfulStatusCode);
			} catch (error) {
				return c.json({ error: `Proxy error: ${JSON.stringify(error)}` }, 500);
			}
		});
	}
}
