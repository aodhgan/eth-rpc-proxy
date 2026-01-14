# PRD: Request Delay Feature

## Introduction

Add configurable delay to the proxy to simulate slow network conditions for testing purposes. The delay can be applied before forwarding requests to upstream (pre-delay) and/or after receiving responses before sending to client (post-delay). This enables testing of application behavior under high-latency network conditions.

## Goals

- Allow configuring a fixed delay in milliseconds via environment variables
- Support delaying requests before forwarding to upstream (pre-delay)
- Support delaying responses before sending to client (post-delay)
- Enable/disable each delay type independently
- Maintain backward compatibility (no delay by default)

## User Stories

### US-001: Add pre-request delay via environment variable
**Description:** As a developer, I want to set a delay before requests are forwarded to upstream so that I can simulate slow network conditions.

**Acceptance Criteria:**
- [ ] `PROXY_PRE_DELAY_MS` environment variable sets delay in milliseconds before forwarding
- [ ] Delay is applied to both HTTP and WebSocket requests
- [ ] Default value is 0 (no delay)
- [ ] Delay value is logged at startup if set
- [ ] Typecheck passes

### US-002: Add post-response delay via environment variable
**Description:** As a developer, I want to set a delay after receiving upstream responses so that I can simulate slow response delivery.

**Acceptance Criteria:**
- [ ] `PROXY_POST_DELAY_MS` environment variable sets delay in milliseconds before sending response to client
- [ ] Delay is applied to both HTTP and WebSocket responses
- [ ] Default value is 0 (no delay)
- [ ] Delay value is logged at startup if set
- [ ] Typecheck passes

### US-003: Support programmatic delay configuration
**Description:** As a developer using the library, I want to configure delays programmatically so that I can set them in my test setup.

**Acceptance Criteria:**
- [ ] `setPreDelay(ms: number)` method added to ProxyServer
- [ ] `setPostDelay(ms: number)` method added to ProxyServer
- [ ] Methods override environment variable values
- [ ] Passing 0 disables the delay
- [ ] Typecheck passes

### US-004: Add delay tests
**Description:** As a developer, I want tests to verify delay behavior works correctly.

**Acceptance Criteria:**
- [ ] Test verifies pre-delay adds expected latency to request
- [ ] Test verifies post-delay adds expected latency to response
- [ ] Test verifies combined delays work correctly
- [ ] Tests pass with `pnpm test`

## Functional Requirements

- FR-1: Read `PROXY_PRE_DELAY_MS` from environment, parse as integer, default to 0
- FR-2: Read `PROXY_POST_DELAY_MS` from environment, parse as integer, default to 0
- FR-3: Apply pre-delay using `setTimeout`/`await` before forwarding HTTP requests in `#setupHttpProxy`
- FR-4: Apply post-delay using `setTimeout`/`await` after receiving HTTP response, before `c.json()`
- FR-5: Apply pre-delay before `upstream.send()` in WebSocket handler
- FR-6: Apply post-delay before `appClient.send()` in WebSocket response handler
- FR-7: Add `setPreDelay(ms: number)` and `setPostDelay(ms: number)` public methods
- FR-8: Log delay configuration at proxy startup if non-zero

## Non-Goals

- No per-method or per-rule delay configuration
- No header-based delay override
- No random/variable delay (fixed delay only)
- No delay configuration via config file

## Technical Considerations

- Use a simple `sleep` utility function: `const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))`
- Delays should be non-blocking (use async/await)
- Consider adding delay info to trace logs for debugging
- Environment variables should be read in constructor or at startup

## Success Metrics

- Delay adds expected latency (within ~10ms tolerance)
- No performance impact when delay is 0
- All existing tests continue to pass

## Open Questions

- Should delay be logged per-request in trace output?
