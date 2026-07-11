# Headless Browser (Playwright) Runbook — DIGIM Phase 2.2

DINA's `BrowserTool` reads JS-rendered pages by driving a headless Chromium. For
security the browser does **not** run in the DINA process — it runs in a separate,
hardened, **network-segregated container**, and DINA connects to it as a thin
client over a WebSocket. This runbook stands that container up safely.

> **Default OFF.** With `DIGIM_WEB_BROWSER_ENABLED=false` (the default) none of
> this is needed — acquisition is the existing HTTP path. Turn it on only when
> you want JS-rendered coverage.

---

## Why a container (the security model)

A headless browser executes **untrusted JavaScript** from every page it visits.
That inverts Phase 1's "untrusted content, trusted infrastructure" assumption.
Two layers contain it:

1. **App layer (in DINA):** every request the browser makes is intercepted and
   run through the same SSRF policy as the HTTP fetcher; images/media/fonts/CSS
   are blocked; there's a per-page request cap, a post-navigation URL re-check,
   a byte cap, and hard timeouts.
2. **Network layer (this container):** even if the app layer is bypassed, the
   container **cannot reach your host or LAN.** This is the guarantee that a
   compromised page "can't leave the environment."

The network layer is the important one. Process isolation stops the browser from
touching the host; **egress filtering stops it from touching your internal
network.** It must be an egress *filter* (deny private ranges, allow public), not
a full block — the browser's job is to reach public URLs.

---

## 1. Compose file

**First, read the installed client version** — the container image MUST match it
exactly, or Playwright throws obscure CDP protocol errors:

```bash
cd ~/dina-server && npm ls playwright   # e.g. playwright@1.61.1  → use v1.61.1 below
```

`ops/browser/docker-compose.yml` (create the directory on the box; substitute the
version you just read for `<VER>`):

```yaml
services:
  browser:
    # MUST equal the installed `playwright` client version (npm ls playwright).
    image: mcr.microsoft.com/playwright:v<VER>-noble
    # The image already bundles playwright at v<VER>, so npx uses it (no re-fetch,
    # no version skew).
    command: >
      npx playwright run-server --port 3000 --host 0.0.0.0
    init: true                      # reap zombie Chromium children
    restart: unless-stopped
    shm_size: "1gb"                 # avoid the classic /dev/shm crash
    read_only: true                 # rootfs read-only
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: "1500m"              # cannot starve Ollama
    cpus: "1.5"
    networks:
      - browsernet
    ports:
      # Bind ONLY to loopback on the host — DINA connects via localhost, the
      # service is never exposed off-box.
      - "127.0.0.1:3000:3000"

networks:
  browsernet:
    driver: bridge
    # Isolated bridge; egress is further restricted by the firewall rules below.
    internal: false
```

Bring it up:

```bash
cd ops/browser
docker compose up -d
docker compose logs --no-log-prefix browser | tail -20   # expect "Listening on ws://0.0.0.0:3000"
```

---

## 2. Egress firewall (the "can't leave" guarantee)

The container must be able to reach the **public** internet but **not** your host
or LAN. Apply an egress filter on the Docker bridge for `browsernet`. Find the
bridge interface, then deny private destinations from that subnet:

```bash
# Identify the browsernet subnet (e.g. 172.20.0.0/16):
docker network inspect browser_browsernet -f '{{(index .IPAM.Config 0).Subnet}}'

# Deny the container subnet from reaching private ranges + cloud metadata,
# while still allowing the public internet (default ACCEPT for the rest).
SUBNET=172.20.0.0/16   # <-- use the value from above
for CIDR in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8; do
  sudo iptables -I DOCKER-USER -s "$SUBNET" -d "$CIDR" -j DROP
done
# Block the IPv6 metadata + private ranges too if IPv6 is enabled:
sudo ip6tables -I DOCKER-USER -s fc00::/7 -j DROP 2>/dev/null || true
```

> Persist these with `iptables-persistent` (or your firewall manager) so they
> survive reboot. Verify: from inside the container, a request to the host's LAN
> IP or `169.254.169.254` must fail, while `https://example.com` must succeed.

```bash
# Verify egress filter (should TIME OUT / fail):
docker compose exec browser sh -lc 'wget -T 3 -qO- http://169.254.169.254/ ; echo "exit=$?"'
# Verify public egress (should succeed):
docker compose exec browser sh -lc 'wget -T 5 -qO- https://example.com | head -c 40; echo'
```

---

## 3. Point DINA at it

Add to DINA's `.env`, then rebuild + reload:

```bash
DIGIM_WEB_BROWSER_ENABLED=true
DIGIM_WEB_BROWSER_WS_ENDPOINT=ws://localhost:3000
DIGIM_WEB_BROWSER_MODE=on-miss          # browser only when HTTP returns a JS shell / 403
# Optional tuning:
# DIGIM_WEB_BROWSER_CONCURRENCY=2        # concurrent browser pages (keep low)
# DIGIM_WEB_BROWSER_NAV_TIMEOUT_MS=20000
# DIGIM_WEB_BROWSER_THIN_TEXT_CHARS=500  # shell-detection threshold
```

Install the Playwright **client** on the DINA host (small — no browser download
needed, the browser lives in the container):

```bash
cd ~/dina-server   # or /var/www/dina-server
npm install         # picks up the optionalDependency "playwright"
npm run rebuild && npm run reload
```

---

## 4. Verify end-to-end

```bash
# Status should show the browser available:
curl -sk https://localhost:8445/dina/api/v1/digim/status -H 'User-Agent: dina-admin' \
  | jq '.web_research | {browserEnabled, browserMode, browserAvailable, browserStatus}'

# Force the browser on a known JS-heavy page and confirm it was used:
curl -sk https://localhost:8445/dina/api/v1/digim/research \
  -H 'Content-Type: application/json' -H 'User-Agent: dina-admin' \
  -d '{"query":"latest posts","seed_urls":["https://example-spa-site/"],"browser_mode":"always"}' \
  | jq '.diagnostics | {fetched, browserUsed, escalated, errors}'
```

`browserUsed >= 1` proves the containerized browser rendered the page.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `browserAvailable:false`, status "playwright not installed" | `npm install` on the DINA host didn't pick up the optional dep — run it, rebuild. |
| `browserAvailable:false`, status "no ws endpoint configured" | Set `DIGIM_WEB_BROWSER_WS_ENDPOINT`. |
| status "browser service marked down (cooldown)" | The container is unreachable/restarting; DINA auto-degrades to HTTP-only and re-probes after the cooldown. Check `docker compose ps/logs`. |
| Obscure `Protocol error` / connect failure | **Version skew** — the `playwright` client and the container image must be the same version. Pin both. |
| Container crashes on complex pages | `/dev/shm` too small — ensure `shm_size: "1gb"`. |
| Memory pressure on the box | Lower `DIGIM_WEB_BROWSER_CONCURRENCY` and/or the container `mem_limit`. |

## Known limit — bot detection

Cloudflare, DataDome, PerimeterX and similar detect headless Chromium and serve
CAPTCHAs or blocks. The browser reaches the JS-rendered **open** web (news, blogs,
docs, most public sites); it is **not** a skeleton key for sites behind enterprise
bot-walls. That is an expected ceiling, not a defect.

## Stronger isolation (future)

For genuinely hostile targets (e.g. the dark-web scenario), escalate the container
to a microVM/syscall-sandbox runtime — gVisor (`runsc`), Firecracker, or Kata —
for a real kernel boundary. Overkill for reading public JS-rendered sites; the
container + egress filter above is the right level for Phase 2.2.
