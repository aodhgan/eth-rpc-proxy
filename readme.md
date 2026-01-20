# 📦 eth-rpc-proxy
[![CI - Tests](https://github.com/aodhgan/eth-rpc-proxy/actions/workflows/CI.yml/badge.svg)](https://github.com/aodhgan/eth-rpc-proxy/actions/workflows/CI.yml)
[![npm version](https://img.shields.io/npm/v/eth-rpc-proxy)](https://www.npmjs.com/package/eth-rpc-proxy)

A lightweight NodeJS RPC proxy server for JSON-RPC (HTTP + WebSocket) built on [Hono](https://hono.dev).  
Useful for **testing, debugging, and simulating** RPC calls over different network behaviors (forward, drop, fail).

![Diagram](./static/diagram.png)

---

## Features
- 🚀 Forward JSON-RPC requests (HTTP + WS) to an upstream node (e.g. Anvil, Geth, Hardhat)  
- 🎲 Deterministic or probabilistic (chaos) proxy behavior (forward / not answer / fail) allows observing/testing application behaviour 
- 🔌 WebSocket + HTTP support  
- 🧪 Designed for testing blockchain RPC clients  
- ⏱️ Configurable pre-request and post-response delays for latency simulation  

---

## Installation

```bash
pnpm add eth-rpc-proxy
# or
npm install eth-rpc-proxy
```

## Usage
### Basic Example
See what your client is doing under the hood! (A single Viem `sendTransaction` may be doing more than you think.)
Easily get programmatic logs like:

```ts
    import {ProxyServer} from "eth-proxy-server"
    ...
    proxy = new ProxyServer(new URL("http://localhost:8545"), 3000, logger); // forward requests to Anvil (already running)
    proxy.setDefaultMode(ProxyMode.Deterministic); // mode to forward all requests
    await proxy.start();
    const wallet = createWalletClient({
        account, // account setup previously
        chain: foundry,
        transport: http("http://localhost:3000")
    }); // create client which points at proxy
    
    await wallet.sendTransaction({
        to: "0x..",
        value: parseEther("0.0"),
    }); // interact with rpc via proxy as normal
    ...

```

Results:
```
[TRACE] 2025-08-19T21:10:24.629Z [EthRpcProxy] (http) 0.954000ms => eth_getTransactionCount ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","pending"]
[TRACE] 2025-08-19T21:10:24.633Z [EthRpcProxy] (http) 1.107000ms => eth_getBlockByNumber ["latest",false]
[TRACE] 2025-08-19T21:10:24.635Z [EthRpcProxy] (http) 0.702000ms => eth_maxPriorityFeePerGas
[TRACE] 2025-08-19T21:10:24.638Z [EthRpcProxy] (http) 0.906000ms => eth_estimateGas [{"from":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","maxFeePerGas":"0x83215600","maxPriorityFeePerGas":"0x3b9aca00","nonce":"0x0","to":"0xea6fe5B681643Aa82566e032A2D4e96D03489db4","value":"0x0"}]
[TRACE] 2025-08-19T21:10:24.643Z [EthRpcProxy] (http) 0.996000ms => eth_sendRawTransaction ["0x02f86c827a6980843b9aca00848321560082520894ea6fe5b681643aa82566e032a2d4e96d03489db48080c080a025777dfeb8ee95e21a01054f880220122c0698b8290251282e8f108890b1546fa01b0aa3399190e7bc9041105e0e107830aee57bc548d15f8eaa34ab151878a7d4"]
```

# Behavior API

Configure how the proxy responds to **each JSON-RPC method** (HTTP + WebSocket).  
You can mix **deterministic queues** and **random probabilities**, and fall back to a **default**.

---

## Behaviors

- `Forward` – normal proxying to the upstream.
- `NotAnswer` – the proxy **sends headers and never finishes the body** (HTTP) or **never replies** (WS).  
  Useful to simulate timeouts. Your client/test should use an `AbortController` or request timeout. Useful to test client retries or timeout handling.
- `Fail` – the proxy returns **HTTP 500** (HTTP) or a **JSON-RPC error frame** (WS).

```ts
export enum ProxyBehavior {
  Forward = "Forward",
  NotAnswer = "NotAnswer",
  Fail = "Fail",
}
```

## Defaults (when no rule matches)
```ts
// Deterministic default: consume a FIFO queue of behaviors
proxy.setDefaultMode(ProxyMode.Deterministic);
proxy.addBehavior(ProxyBehavior.Fail);      // first matching request fails
proxy.addBehavior(ProxyBehavior.NotAnswer); // next one hangs
proxy.clearDefaultQueue();                  // reset

// Random default: choose by probability (must sum to 1)
proxy.setDefaultMode(ProxyMode.Random, {
  [ProxyBehavior.Forward]: 0.80,
  [ProxyBehavior.Fail]: 0.15,
  [ProxyBehavior.NotAnswer]: 0.05,
});
```
**Notes:**
- For deterministic, the queue is consumed only when the default is used (i.e., if no rule matches).
- For random, probabilities must sum to 1 (float acceptable; we validate).

## Per-method Rules (first match wins)
Rules let you target specific methods via a matcher:

- string (exact): "eth_sendRawTransaction"
- RegExp: /^eth_/
- function: (m) => m.startsWith("eth_") && m.endsWith("_raw")

### Shorthand (deterministic, single behavior):
```ts
// First call to this method: Fail, then Forward afterwards
proxy.addRule("eth_sendRawTransaction", ProxyBehavior.Fail);
```
### Deterministic queue:
```ts
proxy.addRule("eth_sendRawTransaction", {
  mode: ProxyMode.Deterministic,
  behaviors: [ProxyBehavior.Fail, ProxyBehavior.NotAnswer, ProxyBehavior.Forward],
});
```
### Random pass thru
```ts
proxy.addRule(/^eth_/, {
  mode: ProxyMode.Random,
  probs: {
    [ProxyBehavior.Forward]: 0.7,
    [ProxyBehavior.Fail]: 0.2,
    [ProxyBehavior.NotAnswer]: 0.1,
  },
});
```

### pushRuleBehavior(match, behavior)
```ts
proxy.addRule("eth_sendRawTransaction", {
  mode: ProxyMode.Deterministic,
  behaviors: [ProxyBehavior.Fail],
});

proxy.pushRuleBehavior("eth_sendRawTransaction", ProxyBehavior.NotAnswer); // queue now: Fail → NotAnswer

```
**Note** : Throws if there’s no deterministic rule with that exact match

### clearRules
Remove all per-method rules:
```ts
proxy.clearRules();
```

### Matching & Precedence

First match wins. Rules are evaluated in insertion order.

If no rule matches, the default mode/queue/probs apply.

### Common Recipes

| Scenario                                | Rule(s)                                                                                       | Notes                                                                 |
|-----------------------------------------|-----------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| **Permanent fail for one method**       | `proxy.addRule("eth_sendRawTransaction", ProxyBehavior.Fail)`                                 | Every call to this method fails immediately.                         |
| **Fail once, then forward**             | `proxy.addRule("eth_sendRawTransaction", { mode: ProxyMode.Deterministic, behaviors: [ProxyBehavior.Fail, ProxyBehavior.Forward] })` | First request fails, second+ requests succeed.                       |
| **Drop next 2 calls, then forward**     | `proxy.addRule("eth_call", { mode: ProxyMode.Deterministic, behaviors: [ProxyBehavior.NotAnswer, ProxyBehavior.NotAnswer, ProxyBehavior.Forward] })` | Simulates timeouts. Client should use timeouts/abort.                |
| **10% hang, 5% fail, 85% forward**      | `proxy.addRule(/^eth_/, { mode: ProxyMode.Random, probs: { [ProxyBehavior.NotAnswer]: 0.10, [ProxyBehavior.Fail]: 0.05, [ProxyBehavior.Forward]: 0.85 } })` | Simulates flaky network behavior.                                    |
| **Fail all methods randomly**           | `proxy.setDefaultMode(ProxyMode.Random, { [ProxyBehavior.Fail]: 1 })`                         | Everything fails until default mode is changed.                      |
| **Forward everything except one call**  | `proxy.addRule("eth_blockNumber", ProxyBehavior.NotAnswer); proxy.setDefaultMode(ProxyMode.Deterministic);` | All requests forward except `eth_blockNumber` which hangs.           |
| **Forward by default, fail occasionally** | `proxy.setDefaultMode(ProxyMode.Random, { [ProxyBehavior.Forward]: 0.9, [ProxyBehavior.Fail]: 0.1 })` | Adds background failure rate to all unmatched methods.               |
| **Custom logic matcher**                | `proxy.addRule((m) => m.startsWith("eth_") && !m.includes("send"), ProxyBehavior.NotAnswer)`  | Flexible logic for targeting groups of methods.                      |
| **Fail once every 3 calls** | `proxy.addRule("eth_call", { mode: ProxyMode.Deterministic, behaviors: [ProxyBehavior.Fail, ProxyBehavior.Forward, ProxyBehavior.Forward] }); proxy.pushRuleBehavior("eth_call", ProxyBehavior.Fail);` | Queue cycles fail → forward → forward → fail … |

---

## Request Time Delays

Simulate network latency by adding configurable delays before and/or after each request. Useful for testing timeout handling, loading states, and slow network conditions.

### Configuration

**Via environment variables:**
```bash
PROXY_PRE_DELAY_MS=100 PROXY_POST_DELAY_MS=50 pnpm start
```

**Via API:**
```ts
proxy.setPreDelay(100);   // 100ms delay before forwarding request to upstream
proxy.setPostDelay(50);   // 50ms delay after receiving response, before sending to client
```

### Delay Types

| Delay | When Applied | Use Case |
|-------|--------------|----------|
| **Pre-delay** | Before forwarding request to upstream | Simulate slow request initiation, test client timeout before response starts |
| **Post-delay** | After receiving upstream response, before sending to client | Simulate slow response delivery, test loading states |

### Example: Testing Slow Network
```ts
const proxy = new ProxyServer(new URL("http://localhost:8545"), 3000, logger);
proxy.setPreDelay(200);   // 200ms before each request
proxy.setPostDelay(100);  // 100ms after each response
await proxy.start();

// All requests through the proxy will now have 300ms total added latency
```

---

## Testing
To test this package, run:
```bash
pnpm i
pnpm test --run
```

hello