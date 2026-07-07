# Edge-Case Coverage

Two tiers: **automated** (deterministic, hermetic — run in CI/locally) and a
**manual runbook** for the network/LLM paths that a hermetic test can't exercise.

## Automated (90 assertions — `tests/edgeCases.ts`)

Run: `npx ts-node digim-web-research/tests/edgeCases.ts`

### SSRF guard — the security-critical surface
| Case | Handling |
|---|---|
| IPv4 private/loopback/link-local (`10/8`, `127/8`, `192.168/16`, `172.16/12`) | Blocked (`private_address`) |
| Cloud metadata `169.254.169.254` | Blocked |
| CGNAT `100.64/10`, benchmark `198.18/15`, TEST-NETs, multicast/reserved | Blocked |
| IPv6 loopback `::1`, ULA `fc00::/7`, link-local `fe80::/10`, multicast | Blocked |
| IPv4-mapped `::ffff:127.0.0.1`, NAT64 `64:ff9b::7f00:1` | Blocked (embedded v4 re-checked) |
| Public IPs (`8.8.8.8`, `1.1.1.1`, `2606:4700::…`) | Allowed |
| Malformed IPs / empty / out-of-range | **Fail closed** (blocked) |
| Non-http schemes (`ftp:`, `file:`, `javascript:`) | Blocked (`bad_scheme`) |
| Embedded credentials (`http://u:p@host`) | Blocked (`embedded_credentials`) |
| Unparseable URL | Blocked (`parse_error`) |
| Non-allowlisted port (`:22`) | Blocked (`port_not_allowed`) |
| Denylist host (suffix match `sub.evil.com`) | Blocked (`host_denied`) |
| Allowlist active, host not in it | Blocked (`host_not_allowed`) |
| Guard disabled | Passes through (documented, logged) |

### Content extractor
| Case | Handling |
|---|---|
| Full article with nav/header/footer/aside/script/style | Boilerplate removed, main text kept |
| HTML entities (`&amp;`, numeric, hex) | Decoded |
| Metadata (`<title>`, `og:*`, author, published, `lang`) | Extracted + date normalized to ISO |
| Same text, different wrapper tags | **Identical content hash** (dedup works) |
| Empty HTML | 0 words, title falls back to URL slug, no throw |
| Malformed/unclosed HTML | Handled without throwing |
| `text/plain` | Passed through cleanly |

### Quality scorer
| Case | Handling |
|---|---|
| All five facets | Bounded to `[0,1]` |
| Query-matching content | High relevance |
| `.gov`/`nature.com` etc. | Authority boosted; `blogspot`/`medium` reduced |
| Recent vs old `publishedAt` | Freshness decays (180-day half-life) |
| Duplicate flag | Uniqueness penalized |
| Tiny doc | Low completeness |

### Config & providers
| Case | Handling |
|---|---|
| Out-of-range / non-numeric env values | Clamped / fall back to defaults |
| `provider=none` | Returns `[]` without any network call |
| `provider=searxng/brave/tavily` | Correct provider selected |

## Manual runbook (network + LLM paths)

These require a live SearXNG/Brave/Tavily and a running Ollama, so they are not
in the hermetic harness. Verified logic paths noted.

| Case | Expected | Status |
|---|---|---|
| Fetch a real public article | `ok:true`, extracted text + hash | ✅ code path exercised live (see `VERIFICATION.md`); HTML retrieval blocked only by the sandbox proxy (403) |
| Fetch loopback on the live path | Blocked by guard pre-connect | ✅ verified live |
| Redirect chain within limit | Followed, each hop re-validated | Covered by manual-redirect logic |
| Redirect that lands on a private host | Blocked at the offending hop | Guard runs on every hop |
| Oversized body (> `MAX_CONTENT_BYTES`) | Streamed read aborts, `ok:false` | Byte-capped reader |
| Non-textual content-type (PDF/image) | Skipped, `unsupported content-type` | Content-type gate |
| Fetch timeout | `ok:false`, retried with backoff | AbortController + retry loop |
| Provider unreachable | Search returns `[]`, gather yields 0 docs, no crash | Provider `search()` never rejects |
| LLM down during synthesis | **Degraded insight** from source metadata, `confidence:0.2` | `degradedInsight()` |
| LLM returns non-JSON / fenced JSON | Parsed via fence-strip + brace-clamp; on failure → degraded insight | `parseJsonResponse` + fallback |
| Zero documents gathered | Honest empty insight, no hallucination | `emptyInsight()` |
| Same query within TTL | Served from `digim_intelligence` cache (`cached:true`) | `getFreshIntelligence` |
| Duplicate content across runs | Not re-inserted; `duplicate:true` | `content_hash` unique + `findByHash` |
| `DIGIM_WEB_ENABLED=false` | Endpoints return `disabled`/placeholder; **no network, no LLM** | Master gate |

## Known residual risk (documented, not hidden)

**DNS-rebinding TOCTOU.** The guard resolves and validates a host's IPs, but the
global `fetch` performs its own resolution at connect time — a hostile resolver
could return a public IP to the guard and a private IP to `fetch`.
**Mitigations:** (1) populate `DIGIM_WEB_ALLOWED_HOSTS` in hostile environments;
(2) a future upgrade can pin the validated IP via a custom undici dispatcher
`lookup`. This does not affect direct-IP-literal or metadata-endpoint attacks,
which are blocked outright.
