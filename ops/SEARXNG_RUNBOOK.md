# SearXNG Runbook — autonomous search discovery for DIGIM

DIGIM's `SearchProvider` layer supports a self-hosted **SearXNG** meta-search
(free, no API key, aggregates Google/Bing/DuckDuckGo/etc.). Once it's running and
DINA points at it, `digim_research` and `digim_search` work from a **query
alone** — DINA discovers her own sources instead of needing `seed_urls`.

> **Critical detail:** SearXNG ships with the **JSON API disabled**. DINA needs
> JSON. You MUST enable it in `settings.yml` (`search.formats` includes `json`),
> or every search returns 0 results.

## 1. Stand it up (Docker, recommended)

```bash
sudo mkdir -p /opt/searxng
cd /opt/searxng
```

Create `docker-compose.yml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    ports:
      - "127.0.0.1:8080:8080"        # bind to localhost only — DINA is on the same host
    volumes:
      - ./searxng:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080/
      - SEARXNG_SECRET=${SEARXNG_SECRET}   # set a long random value
    restart: unless-stopped
    cap_drop: [ALL]
    cap_add: [CHOWN, SETGID, SETUID]
```

First run generates a default config, then we enable JSON:

```bash
export SEARXNG_SECRET="$(openssl rand -hex 32)"
docker compose up -d
sleep 5                                   # let it write the default settings.yml
```

Enable the JSON format + a sane rate limit, then restart:

```bash
# Append the JSON format to the generated settings.yml
sudo sed -i 's/^\(\s*formats:\).*/\1\n    - html\n    - json/' searxng/settings.yml 2>/dev/null || true
# If the sed above didn't match (format varies by version), edit by hand:
#   search:
#     formats:
#       - html
#       - json
docker compose restart
```

## 2. Verify JSON works

```bash
curl -s 'http://localhost:8080/search?q=lithium+ion+battery&format=json' | head -c 300
# Expect a JSON object with a "results" array. If you get HTML or a 403,
# JSON isn't enabled yet — fix search.formats in settings.yml and restart.
```

## 3. Point DINA at it

Add to DINA's `.env` (repo root) and redeploy:

```bash
DIGIM_WEB_ENABLED=true
DIGIM_WEB_SEARCH_PROVIDER=searxng
DIGIM_WEB_SEARXNG_URL=http://localhost:8080
```
```bash
cd /var/www/dina-server && npm run rebuild && sudo pm2 reload ecosystem.config.js && sleep 30
```

Confirm DINA sees it:

```bash
# Provider wired up? (provider_configured: true, candidates listed)
curl -sk https://localhost:8445/dina/api/v1/digim/search \
  -H 'Content-Type: application/json' -H 'User-Agent: dina-admin' \
  -d '{"query":"who won the 2026 nba finals"}' | jq '{provider, provider_configured, candidate_count, first: .candidates[0]}'
```

## 4. Autonomous research (no seed_urls!)

```bash
curl -sk https://localhost:8445/dina/api/v1/digim/research \
  -H 'Content-Type: application/json' -H 'User-Agent: dina-admin' \
  -d '{"query":"latest advances in solid-state batteries 2026","intelligence_level":"deep"}' \
  | jq '{summary: .insight.summary, sources: [.insight.sources[].url], diagnostics}'
```
`diagnostics.searchProvider` should read `searxng` and `candidatesFound > 0` — DINA found the sources herself.

## Tuning / safety

- `DIGIM_WEB_MAX_SEARCH_RESULTS` (default 10) — how many candidates to request.
- `DIGIM_WEB_MAX_DOCUMENTS` (default 8) — how many to actually fetch+extract.
- Every discovered URL still passes the **SSRF guard** before fetch; `digim_search`
  shows each candidate's `safe`/`safety_reason` so you can audit before gathering.
- Bind SearXNG to `127.0.0.1` (as above) so it isn't publicly exposed.
- Keep `safesearch=1` (DINA requests it) and set per-engine limits in SearXNG if
  you hit upstream rate limits (Google may CAPTCHA aggressive querying).

## Alternatives (no SearXNG)

Set `DIGIM_WEB_SEARCH_PROVIDER=brave` + `DIGIM_WEB_BRAVE_API_KEY=…`, or
`=tavily` + `DIGIM_WEB_TAVILY_API_KEY=…`. Same discovery flow, paid APIs. Or keep
`=none` and drive research with explicit `seed_urls` (what you've used so far).
