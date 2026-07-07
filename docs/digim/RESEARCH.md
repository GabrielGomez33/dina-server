# Best-Practices Research — Web Gathering for AI Agents (2025–2026)

This is the research that grounded the subsystem design. Each finding maps to a
concrete decision in the code.

## 1. Pipeline architecture: search → read → cross-check → synthesize

A "deep research" agent **searches, reads, cross-checks, and combines results
across sources without waiting for human input between steps**, then searches
again with better questions. The consensus architecture separates an
**orchestration layer** (interprets intent, plans tool calls) from **tool
execution** (search, fetch, extract), with **observability on every decision and
tool call**.

**→ Decision.** The subsystem is a linear, fault-isolated pipeline
(`SearchProvider → WebFetcher → ContentExtractor → QualityScorer → Store →
Synthesizer`) behind a facade (`WebResearchOrchestrator`). Every stage emits
diagnostics (`GatherDiagnostics`) so every candidate URL's fate is observable.

## 2. Least privilege / "excessive agency"

The dominant agent-security failure mode is **excessive agency**: more tools,
broader permissions, or higher-impact actions than the task needs. The fix is to
**scope tools tightly, apply least privilege, and require approval for
consequential actions**.

**→ Decision.** The subsystem is **read-only** (it fetches and reads, never
POSTs to arbitrary hosts), **disabled by default**, **config-gated**, and its
search providers only *produce* URLs — they never fetch them. It gets its own
isolated `DinaLLMManager` so a failure can't cascade into chat/TruthStream.

## 3. SSRF prevention (the critical security control)

OWASP and the Node.js security literature converge on:

- **Parse with the WHATWG `URL` API, never regex** — regex "fails against encoded
  payloads, nested schemes, and normalization tricks."
- **Scheme allowlist** (`http`/`https` only).
- **Resolve DNS and reject any answer** in private/loopback/link-local ranges —
  `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, and the cloud-metadata
  `169.254.169.254` — for **both** A and AAAA records.
- **Port allowlist**; reject embedded credentials.
- **Allowlist trusted domains** where feasible; blacklists/regex are the common
  failure.

**→ Decision.** `urlGuard.ts` implements all of the above, plus IPv6 ULA/link-
local/mapped-IPv4/NAT64 handling, host allow/deny lists, and **per-redirect-hop
re-validation** (a plain fetch would auto-follow a 302 into an internal host).
Residual DNS-rebind TOCTOU risk is documented in `EDGE_CASES.md`.

## 4. Search API landscape (why pluggable, why SearXNG default)

- **Microsoft retired the Bing Search API in 2025**, leaving **Brave** as the
  main independent Western index (now a paid tier).
- **SearXNG** is a self-hosted meta-search aggregating 200+ sources; API cost is
  zero (you pay only for the VPS) — a strong fit for an **on-prem** system that
  already runs its own Ollama/GPU stack.
- **Tavily** is a popular AI-native search+extract API (being acquired by
  Nebius, Feb 2026).
- The market is volatile — coupling to one vendor is a liability.

**→ Decision.** A `SearchProvider` interface with SearXNG (self-hosted default
recommendation), Brave, Tavily, and a graceful `none` implementation. Swapping
providers is an env change, not a code change.

## 5. Content extraction (readability, boilerplate removal)

Main-content extraction is either **heuristic** (main content is text-dense and
tag-sparse — the basis of **Mozilla Readability**) or **ML-based** (Trafilatura,
Boilerpipe). Readability/Trafilatura score highest on precision/recall
benchmarks; extracting only the main body (not layout noise) materially improves
downstream embeddings/synthesis.

**→ Decision.** A **dependency-free heuristic extractor** implementing the
readability insight (score block-level elements by text density, strip
`nav/header/footer/aside/script/style`) so the subsystem adds **zero npm
packages**. A Mozilla-Readability adapter can be dropped in behind the same
interface later (see `INTEGRATION.md`).

---

## Sources

- [Firecrawl — Web Search and Deep Research for AI Agents](https://www.firecrawl.dev/blog/deep-research-for-ai-agents)
- [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [web.dev — Introduction to agents](https://web.dev/articles/ai-agents)
- [OWASP — SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP — SSRF Prevention in Node.js](https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs)
- [Snyk — Preventing SSRF in Node.js applications](https://snyk.io/blog/preventing-server-side-request-forgery-node-js/)
- [Firecrawl — Best Web Search APIs for AI Applications](https://www.firecrawl.dev/blog/best-web-search-apis)
- [Brave Search API](https://brave.com/search/api/)
- [Trafilatura — Evaluation of extraction libraries](https://trafilatura.readthedocs.io/en/latest/evaluation.html)
- [WebcrawlerAPI — Extracting article content with Mozilla Readability](https://webcrawlerapi.com/blog/how-to-extract-article-or-blogpost-content-in-js-using-readabilityjs)
