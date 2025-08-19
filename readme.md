# 📦 eth-rpc-proxy
A lightweight RPC proxy server for **JSON-RPC (HTTP + WebSocket)** built on [Hono](https://hono.dev).  
Useful for testing, debugging, and simulating RPC calls over different network behaviors (forward, drop, fail).

![Diagram](./static/diagram.png)

Get programmatic logs like:
[TRACE] [EthRpcProxy] (http) 1.119000ms => eth_getBlockByNumber
[TRACE] [EthRpcProxy] (http) 1.301000ms => eth_getBalance
[TRACE] [EthRpcProxy] (http) 0.811000ms => eth_getTransactionCount
[TRACE] [EthRpcProxy] (http) 1.027000ms => eth_getBlockByNumber
[TRACE] [EthRpcProxy] (http) 0.563000ms => eth_maxPriorityFeePerGas
[TRACE] [EthRpcProxy] (http) 0.815000ms => eth_estimateGas

---

## ✨ Features
- 🚀 Forward JSON-RPC requests (HTTP + WS) to an upstream node (e.g. Anvil, Geth, Hardhat)  
- 🎲 Deterministic or probabilistic proxy behavior (forward / not answer / fail)  
- 🔌 WebSocket + HTTP support  
- 🧪 Designed for testing blockchain RPC clients  

---

## 📦 Installation

```bash
pnpm add eth-rpc-proxy
# or
npm install eth-rpc-proxy
```

## Usage
### Basic Example
```ts
import { ProxyServer, ProxyBehavior, ProxyMode } from "rpc-proxy";

const proxy = new ProxyServer(
  8545, // upstream (Anvil) port
  8546, // proxy port
);

proxy.start();

console.log(`Proxy running at http://localhost:8546`);
```

### Control Behaviour
```ts
// Deterministic mode: drop the next eth_sendRawTransaction call
proxy.addBehavior(ProxyBehavior.NotAnswer);

// Random mode: fail 20% of calls, forward 80%
proxy.setMode(ProxyMode.Random, {
  [ProxyBehavior.Fail]: 0.2,
  [ProxyBehavior.Forward]: 0.8,
  [ProxyBehavior.NotAnswer]: 0,
});
```

## Testing
Run tests:
```bash
pnpm test
```

