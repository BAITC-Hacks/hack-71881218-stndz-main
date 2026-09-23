# Graph Intelligence Engine — agent instructions

Persistent instructions for any AI agent working in `analytics/`. Read this before touching code in this directory.

## Ownership

**Owner:** Ali (Участник 1). **Scope:** `analytics/`, `run_pipeline.py`, `tests/analytics/`, `output/`.

**Out of scope — do not modify without team sign-off:** `ui/`, `copilot/`, backend API, `requirements.txt`, `.gitignore`, `docs/HACKALEM_TEAM_PLAN.md`, `context/TASK.md`, `starter/`.

`output/graph.json` is a shared integration contract — its schema is defined in `docs/GRAPH_DATA_CONTRACT.md` and in `HACKALEM_TEAM_PLAN.md` §3. Fields may be **added**; existing fields must not be renamed, retyped, or removed without notifying Участник 2 and Участник 3.

## Non-negotiable invariants

These are checked by tests. Breaking any of them fails the hackathon's must-have criteria.

1. **All 2 248 nodes survive every stage.** `nodes_roles.csv` has exactly 2 248 rows. The 19 isolated seed clients have no edges and are silently dropped by any graph built from `edges` alone — always `G.add_nodes_from(nodes.gid)` **before** adding edges.
2. **Depth-4 nodes are never labeled `terminal`.** All 444 nodes at `depth == 4` have `out_deg == 0` because the crawl stopped there, not because money stopped. They get role `boundary`. Absence of an observed outgoing transfer is not evidence of retention.
3. **Seed nodes never get role `transit`.** The graph was crawled *from* seeds along outgoing transfers, so their inbound totals are structurally incomplete and `pass_through` is meaningless for them.
4. **No literal GIDs anywhere in `analytics/`.** Demo nodes are picked from pipeline output at presentation time. A grep test enforces this.
5. **Determinism.** Every randomized call takes `seed=42`. Two consecutive runs must produce byte-identical CSVs.
6. **All metrics are computed on one single graph object** containing all 2 248 nodes. PageRank computed with and without the 19 isolates differs by ~9e-05 per node — mixing graphs silently corrupts comparisons.

## Data observability limits — always respected

The dataset shows **only outgoing transfers, 4 hops, from 81 seeds, July 2026, ≥ 5 000 KZT, intra-bank only.**

Consequences that must be encoded in logic and surfaced in `evidence`:

- Inbound flows from outside the sample are invisible. `ext_inflow = max(0, out_kzt − in_kzt)` is the observable proxy; 80 nodes have it above 1 M KZT.
- `out_deg == 0` at `depth < 4` **is** informative (the crawl did look for outgoing edges and found none ≥ 5 000 KZT). At `depth == 4` it is **not**.
- `depth` in `nodes.parquet` is the *minimum* hop. `edges.depth` is the BFS discovery hop, **not** the sender's depth — 509 edges point backwards and 236 sideways.
- Structuring below 5 000 KZT is invisible. Say so rather than concluding it is absent.

## Language and framing rules

- Code, identifiers, comments, docstrings: **English**.
- `evidence`, `why`, `hypothesis` output strings: **Russian**, ≤ 200 characters, must contain at least one number.
- `role_score` is confidence that a **structural pattern** matches, never a probability of criminal activity. Never name a variable or write a string implying guilt.
- All output phrasing is hypothesis-shaped: «признаки консолидации», not «организатор». The AML analyst decides, the engine describes observable structure.
- Never invent client attributes. The data has no names, ages, income, account types or balances — any such field is fabrication.

## Architecture rules

- One-way data flow: each module takes a DataFrame and returns it with added columns. No back-references between modules.
- **`analytics/config.py` is the only place that holds numeric constants.** Every threshold, weight and cap lives there. Never inline a threshold in a function body — the jury asks to see the thresholds table, and README copies it from `config.py`.
- Reuse the organizers' `starter/starter.py` where sensible (`load`, `sanity_check`, `build_graph`, feature core, output schema). Do not reuse its `hints()`.
- Do not add dependencies beyond pandas / pyarrow / networkx / numpy / pytest without a stated reason.
- Do not optimize for performance: the entire heavy algorithm set runs in ≈1 s against a 300 s budget. Spend the time on explainability instead.

## Known traps

- **`nx.hits(G)` raises `PowerIterationFailedConvergence` on this graph** with default parameters, despite being recommended in `starter/README.md`. Use `max_iter=1000` or avoid HITS entirely.
- **Louvain community count varies across networkx versions** even with `seed=42` (91 on nx 3.7 vs 87 reported in the team plan from an unseeded run). `networkx` must be pinned to an exact version in `requirements.txt`.
- **`gid` exceeds 2^53** (max `100000008782800100`). It must be serialized as a **string** in `graph.json` or JavaScript silently truncates it and gid search breaks. In CSV it stays `int64` per the spec.
- `pass_through` is undefined for the 42 nodes with `in_kzt == 0`. Handle the NaN explicitly; never let it silently become `False` in a comparison chain without an intentional `.fillna()`.

## Workflow

Work phase by phase (`docs/GRAPH_ENGINE_PLAN.md` §6). After each phase: run tests, verify spec compliance, update `docs/GRAPH_ENGINE_PROGRESS.md`, log significant choices in `docs/GRAPH_DECISIONS.md`, then stop at the checkpoint.

**Never claim tests passed without running them.** If testing is impossible, say why explicitly.

**Never create a git commit or push without Ali's explicit permission.**

## Context restoration

Starting a fresh session: read `docs/GRAPH_ENGINE_PROGRESS.md` (current state) → this file (rules) → `docs/GRAPH_ENGINE_PLAN.md` (architecture and measured facts) → `docs/GRAPH_DECISIONS.md` (why things are the way they are). Do not rely on chat history. Do not re-read the whole repository for a local task.
