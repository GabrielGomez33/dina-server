# Redis Stack / RediSearch Runbook (semantic memory)

DINA's semantic memory (Phase 1) stores document embeddings as vectors and finds
"conceptually similar" content with a **k-nearest-neighbour (KNN) vector
search**. That search runs natively and fast only when Redis has the
**RediSearch** module (shipped in **Redis Stack**).

**You do not strictly need it to function.** `src/config/redis.ts` already
detects RediSearch (`FT._LIST`) and, when it's absent, falls back to an
in-process similarity computation. The fallback is correct but O(N) — fine for
thousands of documents, slow at hundreds of thousands. Since the goal is to
scale, install RediSearch when you can.

---

## 1. Check whether you already have it

```bash
redis-cli MODULE LIST          # look for a module named "search" / "ReJSON"
# or
redis-cli FT._LIST             # errors if RediSearch is absent
```

If `FT._LIST` returns (even an empty list), you're done — DINA will log
`✅ RediSearch module detected and available` on boot.

## 2A. Recommended: Redis Stack via Docker

The simplest path is the official `redis-stack-server` image, which bundles
RediSearch (+ RedisJSON, etc.):

```bash
docker run -d --name dina-redis \
  -p 6379:6379 \
  -v dina-redis-data:/data \
  redis/redis-stack-server:latest
```

Then point DINA at it (already the default):

```bash
REDIS_URL=redis://localhost:6379
```

A `docker-compose` service equivalent:

```yaml
services:
  redis:
    image: redis/redis-stack-server:latest
    ports: ["6379:6379"]
    volumes: ["dina-redis-data:/data"]
    restart: unless-stopped
volumes:
  dina-redis-data:
```

## 2B. Native install (Debian/Ubuntu)

```bash
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/redis.list
sudo apt-get update
sudo apt-get install -y redis-stack-server
sudo systemctl enable --now redis-stack-server
```

## 2C. Add the module to an existing Redis

If you run a stock Redis and want to keep it, load just the module:

```
# in redis.conf
loadmodule /path/to/redisearch.so
```
then restart Redis.

## 3. Verify end-to-end

```bash
redis-cli FT._LIST
# DINA boot log should show:
#   ✅ RediSearch module detected and available
#   🔍 Created vector index: embeddings   (DIM 1024, COSINE)
```

## 4. Dimensions must match the embedding model

- DINA embeds with **`mxbai-embed-large`** → **1024-dim** vectors.
- The Redis vector index is created with `DIM 1024` (`redis.ts`
  `defaultVectorDimensions: 1024`). **These already match.**
- If you ever switch embedding models, update `defaultVectorDimensions` and
  **drop + recreate** the `embeddings` index (`redis-cli FT.DROPINDEX embeddings`),
  or the store will reject mismatched vectors.

## 5. Persistence

Keep Redis persistence on (AOF or RDB) so embeddings survive restarts. Redis
Stack images persist to `/data` by default (mounted volume above). DINA also
mirrors embeddings to its own persistence layer as a backstop.

## Rollback / no-op

Doing nothing is safe: without RediSearch, DINA uses the in-process fallback and
logs `ℹ️ RediSearch module not available - using manual vector search fallback`.
Install it when scale demands; no code change is required either way.
