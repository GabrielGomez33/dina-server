# Headless Browser (Playwright) Runbook — DIGIM Phase 2.2

DINA's `BrowserTool` reads JS-rendered pages by driving a headless Chromium. For
security the browser does **not** run in the DINA process — it runs in a separate,
hardened, **network-segregated container**, and DINA connects to it as a thin
client over a WebSocket. This runbook stands that container up safely.

> **Default OFF.** With `DIGIM_WEB_BROWSER_ENABLED=false` (the default) none of
> this is needed — acquisition is the existing HTTP path. Turn it on only when
> you want JS-rendered coverage.

## Two "playwrights" — don't confuse them

| | What | Where | How installed |
|---|---|---|---|
| **Browser binaries** (Chromium) | the actual browser that renders pages | **the container** (`mcr.microsoft.com/playwright` image) | comes baked into the image — you never install it on the host |
| **Client library** (`playwright-core`) | gives DINA the `chromium.connect()` call to talk to the container | **the DINA host** (`node_modules`) | `npm install` (it's an optionalDependency) |

The host needs ONLY the small `playwright-core` client — **no browser download on
the host.** (We use `playwright-core`, not full `playwright`, precisely because it
has no browser-download postinstall — the browsers live in the container.)

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

**First, install + read the client version** — the container image MUST match it
exactly, or Playwright throws obscure CDP protocol errors:

```bash
cd ~/dina-server && npm install          # pulls the playwright-core optionalDependency
npm ls playwright-core                    # e.g. playwright-core@1.61.1 → use v1.61.1 below
```

The base `mcr.microsoft.com/playwright` image ships the browser binaries but NOT
the `playwright` CLI on PATH — so we bake the CLI in with a tiny Dockerfile at
BUILD time (writable). At runtime nothing installs, so `read_only: true` holds.

`Dockerfile` (substitute the version you read for `<VER>`):

```dockerfile
FROM mcr.microsoft.com/playwright:v<VER>-noble
# Browsers are already in the image; only add the server CLI (skip re-download).
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright@<VER>
```

`docker-compose.yml`:

```yaml
services:
  browser:
    build:
      context: .
      network: host                 # build uses the host resolver (fixes buildkit EAI_AGAIN/DNS)
    command: playwright run-server --port 3000 --host 0.0.0.0
    init: true                      # reap zombie Chromium children
    restart: unless-stopped
    shm_size: "1gb"                 # avoid the classic /dev/shm crash
    read_only: true                 # rootfs read-only
    tmpfs:
      - /tmp
    environment:
      # With a read-only rootfs, npx's cache and Chromium's per-context profile
      # dirs must land on the writable tmpfs — point HOME there.
      - HOME=/tmp
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

Bring it up (build the image, then start):

```bash
docker compose up -d --build
docker compose logs --no-log-prefix browser | tail -20   # expect "Listening on ws://0.0.0.0:3000"
```

---

## 2. Egress firewall (the "can't leave" guarantee)

The container must reach the **public** internet but **not** your host or LAN.
This needs rules in **TWO** chains — a subtlety that a live test exposed:

- **`DOCKER-USER` (part of `FORWARD`)** sees traffic ROUTED THROUGH the host to
  elsewhere — the public internet, other LAN hosts, cloud metadata. Deny the
  private ranges here.
- **`INPUT`** sees traffic destined for the **host itself** (the bridge gateway,
  e.g. `172.19.0.1`). Container→host packets never hit `FORWARD`, so
  `DOCKER-USER` alone does NOT block them. You must also drop new container→host
  connections in `INPUT`, while keeping established return traffic (so the
  host→container:3000 WebSocket still works).

```bash
# Identify the browsernet subnet (e.g. 172.19.0.0/16):
docker network inspect dina-browser_browsernet -f '{{(index .IPAM.Config 0).Subnet}}'
SUBNET=172.19.0.0/16   # <-- use the value from above

# (a) FORWARD path: deny routed traffic to private ranges + cloud metadata,
#     leave the public internet ACCEPTed.
for CIDR in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8; do
  sudo iptables -I DOCKER-USER -s "$SUBNET" -d "$CIDR" -j DROP
done
sudo ip6tables -I DOCKER-USER -s fc00::/7 -j DROP 2>/dev/null || true

# (b) INPUT path: block NEW container->host connections, allow established
#     returns. (-I inserts on top, so add DROP first, then ACCEPT lands above it.)
sudo iptables -I INPUT -s "$SUBNET" -j DROP
sudo iptables -I INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```

Verify with an A/B (from inside the container, using its bundled Node) — the host
must be UNREACHABLE and the public web REACHABLE:

```bash
GW=172.19.0.1   # the bridge gateway = your host from the container's view
# Host must be BLOCKED:
sudo docker compose exec -T browser node -e "require('net').connect({host:'$GW',port:22,timeout:4000}).on('connect',function(){console.log('REACHED host — BAD');this.destroy()}).on('timeout',function(){console.log('BLOCKED host ✓');this.destroy()}).on('error',e=>console.log('blocked',e.code,'✓'))"
# Public must WORK (also proves DNS):
sudo docker compose exec -T browser node -e "require('net').connect({host:'example.com',port:443,timeout:6000}).on('connect',function(){console.log('PUBLIC ✓');this.destroy()}).on('error',e=>console.log('public FAIL',e.code))"
```

**Persist across reboot** (rules are lost otherwise):

```bash
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save     # saves current v4+v6 rules to /etc/iptables/
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

Install the client (`playwright-core`) on the DINA host — small, no browser
download (the browser lives in the container):

```bash
cd ~/dina-server   # or /var/www/dina-server
npm install                 # picks up the optionalDependency "playwright-core"
npm ls playwright-core      # confirm it's present (should print a version)
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
