# DIGIM graph viewer — moved (single source of truth)

`graph-viewer.html` is a **front-end asset**, so it now lives in exactly one place:

> **`client/public/graph-viewer.html`** — in the client repo
> (`GabrielGomez33/dina`, published by Vite to `dist/` and served at
> `/dina/graph-viewer.html`).

The DINA console embeds it in an `<iframe>` (see `client/src/digim/ExploreView.tsx`)
and drives it with URL params — `?embed=1&api=<base>&research=<id>&focus=<term>&view=<network|semantic>`.
It is also usable standalone: open the file in a browser, set an API base (or serve
it from the DINA domain), and use **Load data** / **Fetch** to paste or pull
`digim_graph` / `digim_semantic` JSON.

## Why this file exists

There used to be a second copy at `docs/digim/graph-viewer.html`. Two copies drift:
a fix applied to one silently left the other stale (the deep-time timeline and the
semantic-tab lazy-load were both fixed in the client copy while this one lagged).
To prevent that class of bug, the `docs/` copy was **deleted**; this pointer marks
where it went. Do not re-add a viewer HTML under `docs/` — edit the canonical file
in the client repo instead.

## What it renders

- **Network** — force-directed relationship graph (entities + edges + provenance).
- **Timeline** — events/relationships placed on a signed-year axis (`occurred_sort`),
  so it spans all of history (BCE / "N years ago" included), labelled by
  `occurred_label`.
- **Semantic** — 3D PCA projection of the research's 1024-D content embeddings
  (`/digim/semantic`), lazily fetched the first time the tab is opened.

All three are scoped to one research (island) via the `research` URL param, so
unrelated researches never bleed into a view.
