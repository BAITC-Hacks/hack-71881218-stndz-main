#!/usr/bin/env python3
"""
Граф денег — полный пайплайн (роли, кластеры, топ, визуализация).

Запуск:
    python pipeline.py --data ./data --out ./out
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

ROLES = [
    "consolidator",
    "transit",
    "distributor",
    "terminal",
    "coordinator",
    "peripheral",
]

# --- пороги (задокументированы в README) ---
IN_DEG_CONSOLIDATOR = 5
OUT_DEG_DISTRIBUTOR = 10
PASS_LO, PASS_HI = 0.8, 1.2
COORD_SEED_NEIGHBORS = 3
COORD_BETWEENNESS_Q = 0.95
TOP_N = 30


def load(data_dir: Path):
    edges = pd.read_parquet(data_dir / "edges.parquet")
    nodes = pd.read_parquet(data_dir / "nodes.parquet")
    tx = pd.read_parquet(data_dir / "transactions.parquet")
    tx["date"] = pd.to_datetime(tx["date"])
    return edges, nodes, tx


def sanity_check(edges, nodes, tx):
    print("=" * 64)
    print("ПРОВЕРКА ДАННЫХ")
    print("=" * 64)
    print(f"  узлов                 : {len(nodes):>6}")
    print(f"  рёбер                 : {len(edges):>6}")
    print(f"  транзакций            : {len(tx):>6}")
    print(f"  seed                  : {int(nodes.is_seed.sum()):>6}")
    print(f"  оборот, KZT           : {edges.sum_kzt.sum():>14,.0f}")
    print(f"  период                : {tx.date.min().date()} — {tx.date.max().date()}")
    agg = tx.groupby(["src", "dst"]).agg(s=("sum_kzt", "sum"), c=("sum_kzt", "size")).reset_index()
    m = edges.merge(agg, on=["src", "dst"], how="outer", indicator=True)
    assert (m["_merge"] == "both").all(), "edges и transactions не сходятся"
    print("  edges == transactions : OK")
    orphans = set(nodes.gid) - (set(edges.src) | set(edges.dst))
    print(f"  orphan-узлов          : {len(orphans)} (все попадут в выгрузки)")
    print("=" * 64, "\n")
    return orphans


def build_graph(edges) -> nx.DiGraph:
    G = nx.DiGraph()
    for r in edges.itertuples(index=False):
        G.add_edge(r.src, r.dst, sum_kzt=float(r.sum_kzt), n_tx=int(r.n_tx), depth=int(r.depth))
    return G


def basic_features(G: nx.DiGraph, nodes: pd.DataFrame, edges: pd.DataFrame) -> pd.DataFrame:
    in_deg = dict(G.in_degree())
    out_deg = dict(G.out_degree())
    in_kzt = dict(G.in_degree(weight="sum_kzt"))
    out_kzt = dict(G.out_degree(weight="sum_kzt"))
    in_tx = dict(G.in_degree(weight="n_tx"))
    out_tx = dict(G.out_degree(weight="n_tx"))
    pr = nx.pagerank(G, weight="sum_kzt")

    # betweenness на подвыборке для скорости; полный граф ~2k — ок
    bw = nx.betweenness_centrality(G, weight="sum_kzt", normalized=True)

    seeds = set(nodes.loc[nodes.is_seed, "gid"])
    # сколько уникальных seed в 1-hop (in или out)
    seed_nbrs = {}
    for n in nodes.gid:
        if n not in G:
            seed_nbrs[n] = 0
            continue
        nbrs = set(G.predecessors(n)) | set(G.successors(n))
        seed_nbrs[n] = len(nbrs & seeds)

    # входящие от seed
    in_from_seed = {}
    for n in nodes.gid:
        if n not in G:
            in_from_seed[n] = 0
            continue
        in_from_seed[n] = sum(1 for p in G.predecessors(n) if p in seeds)

    df = nodes[["gid", "depth", "is_seed"]].copy()
    df["in_deg"] = df.gid.map(in_deg).fillna(0).astype(int)
    df["out_deg"] = df.gid.map(out_deg).fillna(0).astype(int)
    df["in_kzt"] = df.gid.map(in_kzt).fillna(0.0)
    df["out_kzt"] = df.gid.map(out_kzt).fillna(0.0)
    df["in_tx"] = df.gid.map(in_tx).fillna(0).astype(int)
    df["out_tx"] = df.gid.map(out_tx).fillna(0).astype(int)
    df["pagerank"] = df.gid.map(pr).fillna(0.0)
    df["betweenness"] = df.gid.map(bw).fillna(0.0)
    df["seed_neighbors"] = df.gid.map(seed_nbrs).fillna(0).astype(int)
    df["in_from_seed"] = df.gid.map(in_from_seed).fillna(0).astype(int)

    df["pass_through"] = np.where(
        df.in_kzt > 0, df.out_kzt / df.in_kzt.replace(0, np.nan), np.nan
    )
    # обрыв обхода, не настоящий сток
    df["truncated_by_depth"] = (df.depth == 4) & (df.out_deg == 0)
    # кандидат в настоящий terminal: нет исходящих, НЕ depth=4, есть вход
    df["likely_sink"] = (df.out_deg == 0) & (df.in_deg > 0) & (~df.truncated_by_depth)
    return df


def assign_clusters(G: nx.DiGraph, df: pd.DataFrame) -> pd.DataFrame:
    """Louvain на неориентированной проекции + отдельный id для orphan."""
    df = df.copy()
    cluster = {gid: -1 for gid in df.gid}

    if G.number_of_edges() == 0:
        df["cluster_id"] = -1
        return df

    UG = G.to_undirected()
    # вес = sum_kzt
    communities = nx.community.louvain_communities(UG, weight="sum_kzt", seed=42)
    # сортируем по размеру desc для стабильных id
    communities = sorted(communities, key=len, reverse=True)
    for cid, members in enumerate(communities):
        for n in members:
            cluster[n] = cid

    df["cluster_id"] = df.gid.map(cluster).fillna(-1).astype(int)
    return df


def _clip01(x: float) -> float:
    return float(max(0.0, min(1.0, x)))


def assign_roles(df: pd.DataFrame) -> pd.DataFrame:
    """
    Приоритет правил (первое совпадение):
      consolidator > distributor > coordinator > transit > terminal > peripheral

    truncated_by_depth никогда не становится terminal.
    """
    df = df.copy()
    bw_thr = df.betweenness.quantile(COORD_BETWEENNESS_Q) if len(df) else 0.0

    roles, scores, evidence = [], [], []

    for r in df.itertuples(index=False):
        role = "peripheral"
        score = 0.15
        ev = "нет выраженных признаков роли"

        # --- consolidator: больше собирает, чем раздаёт по числу контрагентов ---
        if r.in_deg >= IN_DEG_CONSOLIDATOR and r.in_deg >= r.out_deg:
            role = "consolidator"
            retain = 1.0 - (r.out_kzt / r.in_kzt) if r.in_kzt > 0 else 0.0
            score = _clip01(0.5 + 0.03 * min(r.in_deg, 20) + 0.2 * max(retain, 0))
            ev = (
                f"получает от {r.in_deg} плательщиков ({r.in_kzt:,.0f} KZT), "
                f"отдаёт {r.out_deg} ({r.out_kzt:,.0f} KZT)"
            )[:200]

        # --- distributor: явный веер ---
        elif r.out_deg >= OUT_DEG_DISTRIBUTOR:
            role = "distributor"
            score = _clip01(0.5 + 0.004 * min(r.out_deg, 120))
            ev = (
                f"веер на {r.out_deg} получателей ({r.out_kzt:,.0f} KZT), "
                f"in_deg={r.in_deg}"
            )[:200]

        # --- consolidator: много входов, даже если есть исходящие ---
        elif r.in_deg >= IN_DEG_CONSOLIDATOR:
            role = "consolidator"
            score = _clip01(0.45 + 0.025 * min(r.in_deg, 20))
            ev = (
                f"аккумулирует от {r.in_deg} источников ({r.in_kzt:,.0f} KZT), "
                f"далее out_deg={r.out_deg}"
            )[:200]
        # --- coordinator ---
        elif (
            (r.seed_neighbors >= COORD_SEED_NEIGHBORS)
            or (r.betweenness >= bw_thr and r.betweenness > 0 and (r.in_deg + r.out_deg) >= 4)
        ) and (r.in_deg + r.out_deg) > 0:
            role = "coordinator"
            score = _clip01(
                0.55
                + 0.08 * min(r.seed_neighbors, 6)
                + 0.25 * min(r.betweenness / (bw_thr + 1e-12), 1.0)
            )
            ev = (
                f"связей с seed={r.seed_neighbors}, betweenness={r.betweenness:.4f}, "
                f"in={r.in_deg}/out={r.out_deg}"
            )[:200]

        # --- transit ---
        elif (
            r.in_deg > 0
            and r.out_deg > 0
            and pd.notna(r.pass_through)
            and PASS_LO <= r.pass_through <= PASS_HI
            and not r.truncated_by_depth
        ):
            role = "transit"
            score = _clip01(0.55 + 0.2 * (1 - abs(r.pass_through - 1.0)))
            ev = (
                f"pass-through={r.pass_through:.2f}: "
                f"in={r.in_kzt:,.0f} → out={r.out_kzt:,.0f} KZT"
            )[:200]

        # --- terminal: заметный сток (не обрыв depth=4) ---
        elif r.likely_sink and (r.in_deg >= 2 or r.in_kzt >= 100_000):
            role = "terminal"
            score = _clip01(0.4 + 0.02 * min(r.in_deg, 10) + 0.1 * min(r.in_kzt / 1e6, 1))
            ev = (
                f"деньги приходят (in_deg={r.in_deg}, {r.in_kzt:,.0f} KZT) "
                f"и не уходят; depth={r.depth}≠4"
            )[:200]

        # --- truncated ---
        elif r.truncated_by_depth:
            role = "peripheral"
            score = 0.2
            ev = (
                f"обрыв обхода depth=4, out=0; in_deg={r.in_deg} — "
                f"не считаем terminal"
            )[:200]

        elif r.likely_sink:
            role = "peripheral"
            score = 0.25
            ev = (
                f"слабый сток in_deg={r.in_deg}, {r.in_kzt:,.0f} KZT "
                f"(ниже порога terminal)"
            )[:200]

        elif r.in_deg == 0 and r.out_deg == 0:
            role = "peripheral"
            score = 0.1
            ev = "нет рёбер в выгрузке (orphan)"
        roles.append(role)
        scores.append(round(score, 4))
        evidence.append(ev[:200])

    df["role"] = roles
    df["role_score"] = scores
    df["evidence"] = evidence
    return df


def priority_score(df: pd.DataFrame) -> pd.DataFrame:
    """Кого смотреть первым: роль × структура × связь с seed × оборот."""
    df = df.copy()
    role_w = {
        "coordinator": 1.0,
        "consolidator": 0.95,
        "distributor": 0.85,
        "transit": 0.55,
        "terminal": 0.45,
        "peripheral": 0.15,
    }
    pr_max = float(df.pagerank.max() or 1.0)
    kzt = df.in_kzt + df.out_kzt
    kzt_max = float(kzt.max() or 1.0)
    deg = df.in_deg + df.out_deg
    deg_max = float(deg.max() or 1.0)

    base = df.role.map(role_w).fillna(0.15)
    struct = 0.35 * (df.pagerank / pr_max) + 0.25 * (deg / deg_max) + 0.25 * (kzt / kzt_max)
    seed_boost = 0.15 * np.minimum(df.seed_neighbors / 5.0, 1.0) + 0.1 * df.is_seed.astype(float)
    trunc_pen = np.where(df.truncated_by_depth, 0.15, 0.0)

    pri = base * 0.45 + struct * 0.4 + seed_boost + 0.1 * df.role_score - trunc_pen
    df["priority_score"] = np.clip(pri, 0, 1).round(4)
    return df


def build_cluster_table(df: pd.DataFrame, edges: pd.DataFrame) -> pd.DataFrame:
    rows = []
    # внутренний оборот кластера
    gid_cluster = dict(zip(df.gid, df.cluster_id))
    for cid, g in df.groupby("cluster_id"):
        members = set(g.gid)
        if cid < 0:
            hyp = "узлы вне рёбер / без сообщества"
            internal = 0.0
        else:
            mask = edges.src.map(gid_cluster).eq(cid) & edges.dst.map(gid_cluster).eq(cid)
            internal = float(edges.loc[mask, "sum_kzt"].sum())
            n_seed = int(g.is_seed.sum())
            role_counts = g.role.value_counts()
            top_role = role_counts.index[0] if len(role_counts) else "peripheral"
            if n_seed >= 3 and role_counts.get("consolidator", 0) >= 1:
                hyp = f"ядро с {n_seed} seed и консолидацией; доминирует {top_role}"
            elif role_counts.get("distributor", 0) >= 2:
                hyp = f"фрагмент раздачи; доминирует {top_role}, seed={n_seed}"
            elif n_seed >= 1:
                hyp = f"компонента вокруг {n_seed} seed; доминирует {top_role}"
            else:
                hyp = f"периферийный кластер без seed; доминирует {top_role}"

        top = (
            g.sort_values("priority_score", ascending=False)
            .head(5)["gid"]
            .astype(str)
            .tolist()
        )
        rows.append(
            {
                "cluster_id": int(cid),
                "n_nodes": int(len(g)),
                "n_seed": int(g.is_seed.sum()),
                "sum_kzt_internal": round(internal if cid >= 0 else 0.0, 2),
                "top_gids": ";".join(top),
                "hypothesis": hyp[:300],
            }
        )
    return pd.DataFrame(rows).sort_values("n_nodes", ascending=False)


def write_outputs(df: pd.DataFrame, clusters: pd.DataFrame, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)

    roles = df[
        ["gid", "role", "role_score", "cluster_id", "priority_score", "evidence"]
    ].copy()
    # доп. колонки для отладки/демо — допустимы
    extra = [
        "depth",
        "is_seed",
        "in_deg",
        "out_deg",
        "in_kzt",
        "out_kzt",
        "pass_through",
        "truncated_by_depth",
        "pagerank",
        "betweenness",
        "seed_neighbors",
    ]
    roles = roles.merge(df[["gid"] + extra], on="gid", how="left")
    assert len(roles) == 2248, f"ожидали 2248 строк, получили {len(roles)}"
    assert roles.evidence.str.len().gt(0).all()
    roles.to_csv(out_dir / "nodes_roles.csv", index=False)

    clusters.to_csv(out_dir / "clusters.csv", index=False)

    top = (
        df.sort_values(["priority_score", "role_score"], ascending=False)
        .head(TOP_N)
        .reset_index(drop=True)
    )
    top_rows = []
    for i, r in enumerate(top.itertuples(index=False), start=1):
        why = (
            f"{r.role}: priority={r.priority_score:.2f}; {r.evidence}"
        )[:400]
        top_rows.append(
            {
                "rank": i,
                "gid": r.gid,
                "role": r.role,
                "priority_score": r.priority_score,
                "why": why,
            }
        )
    pd.DataFrame(top_rows).to_csv(out_dir / "top_nodes.csv", index=False)

    print(f"Выгрузки → {out_dir}/")
    print(roles.role.value_counts().to_string())
    print(f"кластеров: {len(clusters)}, top: {len(top_rows)}")


def build_viz(G: nx.DiGraph, df: pd.DataFrame, out_dir: Path, max_nodes: int = 400):
    """Интерактивный HTML: роли цветом, поиск по title (gid)."""
    try:
        from pyvis.network import Network
    except ImportError:
        print("pyvis не установлен — пропускаем viz")
        return

    color = {
        "consolidator": "#c0392b",
        "coordinator": "#8e44ad",
        "distributor": "#e67e22",
        "transit": "#2980b9",
        "terminal": "#27ae60",
        "peripheral": "#95a5a6",
    }

    # берём топ по приоритету + их соседей, чтобы граф был читаемым
    top_gids = set(
        df.sort_values("priority_score", ascending=False).head(80).gid.tolist()
    )
    keep = set(top_gids)
    for n in list(top_gids):
        if n in G:
            keep.update(list(G.predecessors(n))[:8])
            keep.update(list(G.successors(n))[:8])
    # ограничение
    if len(keep) > max_nodes:
        keep = set(
            df[df.gid.isin(keep)]
            .sort_values("priority_score", ascending=False)
            .head(max_nodes)
            .gid
        )

    H = G.subgraph(keep).copy()
    net = Network(
        height="750px",
        width="100%",
        directed=True,
        bgcolor="#0f1419",
        font_color="#ecf0f1",
        select_menu=True,
        filter_menu=True,
    )
    net.barnes_hut(gravity=-8000, spring_length=120)

    meta = df.set_index("gid")
    for n in H.nodes():
        row = meta.loc[n]
        role = row.role
        title = (
            f"gid={n}<br>role={role}<br>priority={row.priority_score}<br>"
            f"in={row.in_deg}/out={row.out_deg}<br>{row.evidence}"
        )
        size = 8 + 40 * float(row.priority_score)
        if row.is_seed:
            size += 6
        net.add_node(
            int(n) if isinstance(n, (int, np.integer)) else n,
            label=str(n)[-6:],
            title=title,
            color=color.get(role, "#95a5a6"),
            size=size,
            group=role,
        )

    for u, v, data in H.edges(data=True):
        w = float(data.get("sum_kzt", 1))
        net.add_edge(
            int(u) if isinstance(u, (int, np.integer)) else u,
            int(v) if isinstance(v, (int, np.integer)) else v,
            value=max(1, np.log10(w + 1)),
            title=f"{w:,.0f} KZT / {data.get('n_tx', '?')} tx",
            color="#566573",
        )

    legend = {
        "colors": color,
        "note": "Показаны топ-приоритетные узлы и их соседи. Полные роли — в nodes_roles.csv",
        "n_shown": H.number_of_nodes(),
        "n_edges": H.number_of_edges(),
    }
    (out_dir / "viz_meta.json").write_text(json.dumps(legend, ensure_ascii=False, indent=2))

    html_path = out_dir / "graph.html"
    net.write_html(str(html_path), open_browser=False, notebook=False)

    # обёртка с легендой
    body = html_path.read_text(encoding="utf-8")
    banner = """
    <div style="font-family:Segoe UI,sans-serif;background:#1a2332;color:#ecf0f1;
                padding:12px 18px;border-bottom:1px solid #2c3e50">
      <strong>Граф денег</strong> — роли:
      <span style="color:#c0392b">● consolidator</span>
      <span style="color:#8e44ad">● coordinator</span>
      <span style="color:#e67e22">● distributor</span>
      <span style="color:#2980b9">● transit</span>
      <span style="color:#27ae60">● terminal</span>
      <span style="color:#95a5a6">● peripheral</span>
      &nbsp;|&nbsp; поиск узла: Filter / Select внизу &nbsp;|&nbsp;
      полный список: top_nodes.csv
    </div>
    """
    if "<body>" in body:
        body = body.replace("<body>", "<body>" + banner, 1)
        html_path.write_text(body, encoding="utf-8")

    print(f"Визуализация → {html_path} ({H.number_of_nodes()} узлов)")


def export_frontend(
    df: pd.DataFrame,
    clusters: pd.DataFrame,
    edges: pd.DataFrame,
    out_dir: Path,
    frontend_dir: Path,
):
    """JSON + CSV для React UI (frontend/public/data)."""
    public = frontend_dir / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)

    # CSV для жюри / скачивания из UI
    for name in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv"):
        src = out_dir / name
        if src.exists():
            (public / name).write_bytes(src.read_bytes())

    top = (
        df.sort_values(["priority_score", "role_score"], ascending=False)
        .head(TOP_N)
        .reset_index(drop=True)
    )
    top_payload = [
        {
            "rank": i,
            "gid": str(int(r.gid)),
            "role": r.role,
            "priority_score": float(r.priority_score),
            "why": f"{r.role}: priority={r.priority_score:.2f}; {r.evidence}"[:400],
            "evidence": str(r.evidence)[:200],
            "in_deg": int(r.in_deg),
            "out_deg": int(r.out_deg),
            "is_seed": bool(r.is_seed),
            "cluster_id": int(r.cluster_id),
        }
        for i, r in enumerate(top.itertuples(index=False), start=1)
    ]

    nodes_payload = []
    for r in df.itertuples(index=False):
        nodes_payload.append(
            {
                "id": str(int(r.gid)),
                "role": r.role,
                "role_score": float(r.role_score),
                "priority_score": float(r.priority_score),
                "cluster_id": int(r.cluster_id),
                "evidence": str(r.evidence)[:200],
                "depth": int(r.depth),
                "is_seed": bool(r.is_seed),
                "in_deg": int(r.in_deg),
                "out_deg": int(r.out_deg),
                "in_kzt": float(r.in_kzt),
                "out_kzt": float(r.out_kzt),
                "pass_through": None if pd.isna(r.pass_through) else float(r.pass_through),
                "truncated_by_depth": bool(r.truncated_by_depth),
            }
        )

    links_payload = [
        {
            "source": str(int(r.src)),
            "target": str(int(r.dst)),
            "sum_kzt": float(r.sum_kzt),
            "n_tx": int(r.n_tx),
        }
        for r in edges.itertuples(index=False)
    ]

    clusters_payload = [
        {
            "cluster_id": int(r.cluster_id),
            "n_nodes": int(r.n_nodes),
            "n_seed": int(r.n_seed),
            "sum_kzt_internal": float(r.sum_kzt_internal),
            "top_gids": str(r.top_gids),
            "hypothesis": str(r.hypothesis),
        }
        for r in clusters.itertuples(index=False)
    ]

    payload = {
        "meta": {
            "n_nodes": len(nodes_payload),
            "n_edges": len(links_payload),
            "n_clusters": len(clusters_payload),
            "roles": df.role.value_counts().to_dict(),
        },
        "nodes": nodes_payload,
        "links": links_payload,
        "top": top_payload,
        "clusters": clusters_payload,
    }
    path = public / "graph.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    # копия в out/
    (out_dir / "graph.json").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"Frontend data → {path}")


def main():
    ap = argparse.ArgumentParser(description="Пайплайн «Граф денег»")
    ap.add_argument("--data", default="./data", help="папка с parquet")
    ap.add_argument("--out", default="./out", help="куда писать выгрузки")
    ap.add_argument("--frontend", default="./frontend", help="корень React-приложения")
    ap.add_argument("--no-viz", action="store_true", help="не строить legacy pyvis HTML")
    a = ap.parse_args()

    data_dir, out_dir = Path(a.data), Path(a.out)
    edges, nodes, tx = load(data_dir)
    sanity_check(edges, nodes, tx)

    G = build_graph(edges)
    G.add_nodes_from(nodes.gid)

    print("Считаю метрики…")
    df = basic_features(G, nodes, edges)
    print("Кластеризация (Louvain)…")
    df = assign_clusters(G, df)
    print("Роли…")
    df = assign_roles(df)
    df = priority_score(df)

    clusters = build_cluster_table(df, edges)
    write_outputs(df, clusters, out_dir)
    export_frontend(df, clusters, edges, out_dir, Path(a.frontend))

    if not a.no_viz:
        print("Визуализация (pyvis)…")
        build_viz(G, df, out_dir)

    print("\nГотово.")
    print("  CSV:  out/")
    print("  UI:   cd frontend && npm run dev")


if __name__ == "__main__":
    main()
