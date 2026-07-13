# Understanding DINA's Web Research — a from-scratch explanation

A plain-language walkthrough of what we built, how it works, and why each piece
exists. Written for someone new to this territory.

---

## 1. The big picture — an assembly line

When you ask DINA to research something, the question moves down an assembly
line. Each station does ONE job and hands off to the next:

```
   your question
        │
        ▼
 ┌──────────────┐   "which pages might answer this?"      returns a LIST OF URLs
 │  1. SEARCH   │   (SearXNG)                              (not the pages themselves)
 └──────┬───────┘
        ▼
 ┌──────────────┐   "is this URL safe to open?"           blocks internal/dangerous URLs
 │  2. SSRF     │   (urlGuard)
 │     GUARD    │
 └──────┬───────┘
        ▼
 ┌──────────────┐   "download the actual page"            HTTP fetch (cheap) OR
 │  3. FETCH    │   (webFetcher / BrowserTool)            headless browser (for JS pages)
 └──────┬───────┘
        ▼
 ┌──────────────┐   "pull the real text out of the HTML"  strips menus/ads/boilerplate
 │  4. EXTRACT  │   (contentExtractor)
 └──────┬───────┘
        ▼
 ┌──────────────┐   "how good/relevant is this?"          scores + ranks
 │  5. SCORE    │   (qualityScorer)
 └──────┬───────┘
        ▼
 ┌──────────────┐   "remember this by MEANING"            text → vector → Redis
 │  6. EMBED    │   (semanticMemory)                      (so DINA can recall it later)
 └──────┬───────┘
        ▼
 ┌──────────────┐   "write a grounded answer"             the LLM (mistral) reads the
 │  7. SYNTH    │   (webInsightSynthesizer)               pages and writes the briefing
 └──────┬───────┘
        ▼
   the answer
```

The key idea: **no single station knows about the others.** Search only finds
URLs. Fetch only downloads. Extract only cleans. This is "separation of
concerns" — it's why we can swap the HTTP fetcher for a browser at station 3
without touching stations 4–7.

---

## 2. SearXNG — it finds URLs, it does NOT fetch pages

A common misconception: "SearXNG fetches the data." It doesn't.

**SearXNG is a *metasearch engine*.** Think of it as a librarian. You ask "books
about the Strait of Hormuz," and the librarian hands you a **list of titles and
shelf locations** — she does *not* go pull the books and photocopy them for you.

Concretely, SearXNG takes your query, asks several real search engines (Google,
Bing, DuckDuckGo, …) at once, merges their results, removes duplicates, and hands
back a **list of result URLs + short snippets**. It returns this to us as **JSON**
(a structured list), not HTML.

So "only HTML" is backwards in two ways:
- SearXNG gives US **JSON** (a list of hits).
- The **HTML** is what station 3 (the fetcher) downloads afterward, by actually
  visiting each URL SearXNG suggested.

Why use it at all? Because you can't answer a question without first knowing
*which pages to read*. SearXNG is the "where do I look?" step. We chose it because
it's self-hosted (runs on your box), free, and doesn't require paying a search
company for API access.

---

## 3. Fetching — two ways to download a page, and why the browser is risky

Station 3 downloads the page SearXNG pointed at. There are two tools for this:

### (a) The HTTP fetcher — cheap and safe
It does what `curl` does: opens a connection, downloads the raw HTML text, done.
Fast, light, no code runs. **This is the default and handles ~90% of pages.**

But there's a catch with the modern web: many sites send back an almost-empty
HTML skeleton, and then **JavaScript builds the real content in your browser
after the page loads** (React, Vue, Angular, Next.js sites work this way). The
HTTP fetcher doesn't run JavaScript, so it just sees the empty skeleton — "a JS
shell." It got the file, but the file has no content yet.

### (b) The headless browser — powerful and dangerous
To read those pages, you need something that actually **runs the JavaScript** —
i.e., a real browser. "Headless" just means "no visible window"; it's a full
Chromium (the open-source core of Chrome) driven by code instead of a mouse. It
loads the page, runs the JS, waits for the content to appear, then hands us the
finished HTML.

**Here's why that's dangerous.** A browser, by design, *executes code that the
website sends it.* That's normal for browsing — but for us it means: the moment
DINA visits a page, that page's JavaScript runs on our infrastructure. A
malicious page could try to:
- make the browser reach back into your private network ("go fetch
  `http://192.168.1.50/admin`"),
- hit a cloud "metadata" address to steal credentials,
- exploit a bug in the browser itself to break out.

Everything else in Phase 1 assumed *"the content is untrusted, but our machines
are trusted."* The browser **inverts** that: now we're running untrusted code on
our own machine. So we can't just run Chromium next to DINA. We have to put it in
a box it can't escape. That's Docker + the network wall (sections 4–5).

**When does DINA use the browser?** Only when the cheap HTTP fetch comes back as
a JS shell (or gets blocked with a 403). We call this "fetch-first,
render-on-miss." Cheap-and-safe by default; expensive-and-contained only when
necessary.

---

## 4. Docker — isolation, not "deeper access"

You said Docker "takes advantage of Linux features to access deeper hardware."
It's actually the opposite: Docker uses Linux features to **wall a program OFF**,
not to give it deeper access. Let me correct and sharpen this, because the
"why it works" lives here.

### Container vs. Virtual Machine
- A **Virtual Machine** simulates a whole computer: its own fake hardware, its
  own full operating-system kernel, running on top of yours via a "hypervisor."
  Heavy — like building a **separate house** next to yours with its own
  foundation, plumbing, and electrical.
- A **container** does NOT simulate hardware and does NOT run its own kernel. It
  **shares your host's kernel** but is fenced off from everything else. Light —
  like a **locked apartment inside your building**: same foundation and utilities
  (the kernel), but its own door, its own rooms, and it can't see into the other
  apartments.

Docker containers are that "locked apartment." Two Linux features make the walls:

### Namespaces — "what the program can SEE" (isolation)
A namespace gives the container its own private view of one kind of resource:
- **PID namespace:** the container sees *only its own processes*. To Chromium
  inside, it looks like the only thing running on the machine — it can't see or
  touch your DINA process, your database, etc.
- **Network namespace:** the container gets its *own* network interfaces and
  routing table — its own little network, separate from the host's. (This is what
  we then locked down in section 5.)
- **Mount namespace:** the container sees *only its own filesystem* — a minimal
  Linux with Chromium in it. It cannot see your files, your `.env`, your keys.

So "what the program can see" is deliberately tiny. That's the isolation.

### cgroups — "how MUCH the program can use" (limits)
"Control groups" cap resources: we set `mem_limit: 1500m` and `cpus: 1.5`. Even
if a page tried to exhaust memory, the container can't take more than its
allowance — so it **can't starve Ollama or the rest of your box.**

### The extra locks we added
- `read_only: true` — the container's filesystem can't be modified. A compromise
  can't write malware or tamper with the browser.
- `cap_drop: ALL` — Linux "capabilities" are fine-grained root powers (raw
  network sockets, mounting disks, etc.). We drop **all** of them.
- `no-new-privileges` — the process can never gain more power than it starts with.
- loopback-only port (`127.0.0.1:3000`) — the browser service is reachable only
  from your own machine, never from the internet.

So the container isn't about reaching deeper — it's a stripped-down, powerless,
resource-capped, read-only cell that happens to contain a browser.

---

## 5. The network wall — and what "egress" means

### Ingress vs. Egress (the word you asked about)
Think of the container as a building with a mailroom:
- **Ingress** = mail coming **IN** (connections *to* the container). We already
  limited this: only your host can reach it, on one port.
- **Egress** = mail going **OUT** (connections the container *starts* to reach
  other machines). "Egress traffic" = outbound traffic.

Egress is the one that matters most here, and it's subtle: **the browser's whole
job is to make outbound connections** — it has to reach `wikipedia.org`,
`reuters.com`, wherever. So we can't just block all egress; that would make the
browser useless.

What we actually want is an **egress *filter*, not an egress *block*:**
- ✅ ALLOW the container to reach the **public internet** (its job).
- ❌ DENY the container from reaching **your private network and your host** —
  the LAN (`192.168.x`, `10.x`), the host itself, and the cloud "metadata"
  address (`169.254.169.254`).

That way, even if a malicious page fully hijacks the browser, the worst it can do
is talk to the public internet (which it could anyway) — it **cannot** turn
around and attack *you*. That's the "can't leave the environment" guarantee.

### Why the firewall needed TWO chains (the bug you remember)
Firewall rules on Linux (`iptables`) are grouped into "chains," each watching
traffic at a different point:
- **`FORWARD` chain** watches traffic being *routed THROUGH* your host to
  somewhere else — e.g., container → the public internet, or container → some
  other machine on your LAN.
- **`INPUT` chain** watches traffic aimed *AT your host itself*.

My first attempt put all the DROP rules in `FORWARD` (via Docker's `DOCKER-USER`
chain). That correctly blocked the container from reaching *other* private
machines. **But** a packet from the container to **your host itself** is not
"passing through" to somewhere else — it *arrives at* the host, so it's handled
by `INPUT`, and `FORWARD` never sees it. That's why the live A/B test showed the
container could still reach your box (`REACHED host:22`) even with the FORWARD
rules in place.

The fix: also add `INPUT` rules to drop new container→host connections (while
allowing *established* replies, so the DINA↔browser conversation keeps working).
You had this basically right — it's not "forward and backward," it's **FORWARD
(traffic passing through) and INPUT (traffic aimed at the host)**. Same spirit.

**Why this matters as a lesson:** we only found it because we *tested the claim*
instead of trusting it. I said "the container can't reach your host"; the A/B
test said "yes it can." The test was right. Always prove security properties;
don't assert them.

---

## 6. The "silent failure" bug — how a message flows, and why a field vanished

You had this right: "we weren't asking for the right keys in the API, so things
failed silently." Here's the *how* underneath it.

When you `curl` the research endpoint, your JSON body travels through several
layers before it reaches the code that does the work:

```
your curl JSON
   │  { "seed_urls": [...], "browser_mode": "always", ... }
   ▼
API route (routes/index.ts)   ← builds a "DUMP message" for the internal bus
   │  BUT it copied only a FIXED LIST of fields into that message:
   │     query, seed_urls, intelligence_level, max_documents, force_refresh
   │  → "browser_mode" was NOT on that list, so it was DROPPED here.
   ▼
internal message bus (DinaCore) → routes to the DIGIM module
   ▼
handler (digim/index.ts)      ← reads message.browser_mode … which is now missing
   │  missing → falls back to the config default ("on-miss")
   ▼
registry                      ← "on-miss" means "only use the browser for JS shells"
                                 Wikipedia isn't a JS shell → browser never used
```

So nothing *errored*. Every layer did something reasonable with what it received.
The browser simply was never asked for, because the *request to use it* was thrown
away at the very first layer. `browserUsed: 0`, no error — a **silent** failure.

Two lessons baked into the fix:
1. **The API is a whitelist.** When you add a new capability with a new input
   field, you must add that field to the route's forwarded payload, or it silently
   disappears. (We added `browser_mode`.)
2. **No silent failures.** I also added logging to every browser-failure branch,
   so if the browser is ever *asked* to run and fails, it now says exactly why
   instead of quietly falling back. Silence is the enemy of debugging.

---

## 7. The philosophy — defense in depth

Notice we didn't rely on any single protection. We stacked independent layers, so
if one fails, the next still holds:

| Layer | Stops… | If it fails, the next layer… |
|---|---|---|
| App-layer SSRF guard (in DINA) | DINA fetching internal URLs | container walls still contain it |
| Intercepting the browser's own requests | the browser's sub-requests reaching internal IPs | the network filter still drops them |
| Docker namespaces (isolation) | the browser seeing your files/processes | cgroups still cap its resources |
| Docker cgroups (limits) | the browser starving the box | — |
| Network egress FILTER (INPUT+FORWARD) | a compromised browser reaching your host/LAN | — |

This is called **defense in depth.** No layer is trusted to be perfect. The
browser is genuinely risky, so we assumed it *will* eventually be compromised and
made sure that even then, it's trapped in a powerless, read-only, resource-capped
cell that can talk to the public internet but not to you.

---

## Quick glossary

- **Headless browser:** a real browser (Chromium) with no visible window, driven
  by code. Runs JavaScript like a normal browser.
- **Metasearch (SearXNG):** queries many search engines and merges their result
  lists. Returns URLs, not page content.
- **SSRF (Server-Side Request Forgery):** tricking a server into making requests
  it shouldn't (e.g., to its own internal network). The `urlGuard` prevents this.
- **Container:** an isolated, lightweight "apartment" for a program — shares the
  host kernel but is fenced off by namespaces and limited by cgroups.
- **Namespace:** Linux feature that gives a container its own private view of a
  resource (processes, network, filesystem).
- **cgroup:** Linux feature that caps how much CPU/RAM a container may use.
- **Ingress / Egress:** inbound / outbound network traffic.
- **Egress filter:** allow outbound to the public internet, deny outbound to
  private/internal addresses.
- **iptables chain (FORWARD / INPUT):** where a firewall rule applies — FORWARD =
  traffic routed *through* the host; INPUT = traffic aimed *at* the host.
- **Defense in depth:** stacking independent safeguards so no single failure is
  catastrophic.
