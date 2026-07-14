# mirror-server — changes for Goal #1 (Phase 1: GPU Arbiter)

**None required for this phase.**

The GPU Arbiter is entirely internal to `dina-server`. It changes *when* GPU work runs, never the
request/response shape, protocol, or any endpoint mirror-server calls. From mirror-server's point of
view, behavior is identical — @Dina chat and analysis still return the same payloads; they may simply
queue briefly behind a heavy visuals render (and interactive chat is prioritized so that wait is
minimal).

This folder exists so the delivery layout is consistent and ready: **Phase 2 (`DINA/SAGA`)** is
where mirror-server gains real changes — the React/Vite frontend surface (project dashboard, intake
wizard, generation pages, the live WebSocket progress bar) and its API client. Those will be staged
here as mirrored-path files when we build that goal, so the separate mirror-server repo can adopt them
without guesswork.

### Optional (nice-to-have, not required)

If you want operators to *see* GPU-arbitration state in a mirror-server admin view, mirror-server can
surface the new `gpuArbiter` block that dina-server adds to its diagnostics payload
(`getDiagnostics().gpuArbiter` — see `../dina-server/INTEGRATION.md` Step 2). That's a read-only
display addition with no behavioral impact, and can wait until the dashboard work in Phase 2.
