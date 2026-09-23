"""Deterministic Louvain communities and cautious role-based hypotheses."""

import networkx as nx
import pandas as pd

from analytics import config


CLUSTER_NODE_COLUMNS = ("gid", "is_seed", "role", "priority_score")
CLUSTER_EDGE_COLUMNS = ("src", "dst", "sum_kzt")


def assign_communities(
    nodes_roles: pd.DataFrame,
    edges: pd.DataFrame,
    graph: nx.DiGraph,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Assign stable cluster IDs and build schema-complete cluster summaries."""
    missing_node_columns = sorted(set(CLUSTER_NODE_COLUMNS) - set(nodes_roles.columns))
    if missing_node_columns:
        raise ValueError(
            "Cluster node table is missing columns: "
            f"{', '.join(missing_node_columns)}"
        )
    missing_edge_columns = sorted(set(CLUSTER_EDGE_COLUMNS) - set(edges.columns))
    if missing_edge_columns:
        raise ValueError(
            "Cluster edge table is missing columns: "
            f"{', '.join(missing_edge_columns)}"
        )
    if nodes_roles["gid"].isna().any() or nodes_roles["gid"].duplicated().any():
        raise ValueError("Cluster node table must contain unique, non-null gids")
    if nodes_roles[list(CLUSTER_NODE_COLUMNS)].isna().any().any():
        raise ValueError("Cluster node table contains missing role or ranking values")

    node_gids = set(nodes_roles["gid"].astype("int64"))
    if node_gids != set(graph.nodes):
        raise ValueError("Cluster node table and graph must contain the same gids")

    communities = nx.community.louvain_communities(
        graph.to_undirected(),
        weight="sum_kzt",
        seed=config.LOUVAIN_SEED,
    )
    ordered_communities = sorted(
        communities,
        key=lambda members: (-len(members), min(members)),
    )
    cluster_by_gid = {
        int(gid): cluster_id
        for cluster_id, members in enumerate(ordered_communities)
        for gid in members
    }
    if len(cluster_by_gid) != graph.number_of_nodes():
        raise ValueError("Louvain communities do not partition every graph node")

    result = nodes_roles.copy()
    result["cluster_id"] = result["gid"].map(cluster_by_gid).astype("int64")
    result = result.sort_values("gid", kind="mergesort").reset_index(drop=True)

    edge_clusters = edges.loc[:, CLUSTER_EDGE_COLUMNS].copy()
    edge_clusters["src_cluster"] = edge_clusters["src"].map(cluster_by_gid)
    edge_clusters["dst_cluster"] = edge_clusters["dst"].map(cluster_by_gid)
    if edge_clusters[["src_cluster", "dst_cluster"]].isna().any().any():
        raise ValueError("Cluster edges contain gids missing from the graph")
    internal_flow = (
        edge_clusters.loc[
            edge_clusters["src_cluster"] == edge_clusters["dst_cluster"]
        ]
        .groupby("src_cluster", sort=True)["sum_kzt"]
        .sum()
        .to_dict()
    )

    rows = []
    for cluster_id, members in result.groupby("cluster_id", sort=True):
        n_nodes = len(members)
        n_seed = int(members["is_seed"].sum())
        role_counts = members["role"].value_counts().to_dict()
        top_gids = members.sort_values(
            ["priority_score", "gid"],
            ascending=[False, True],
            kind="mergesort",
        ).head(config.CLUSTER_TOP_GID_COUNT)["gid"]
        rows.append(
            {
                "cluster_id": int(cluster_id),
                "n_nodes": n_nodes,
                "n_seed": n_seed,
                "sum_kzt_internal": float(
                    internal_flow.get(cluster_id, config.ZERO_FLOAT)
                ),
                "top_gids": config.CLUSTER_GID_SEPARATOR.join(
                    str(int(gid)) for gid in top_gids
                ),
                "hypothesis": build_cluster_hypothesis(
                    role_counts,
                    n_seed,
                    n_nodes,
                ),
            }
        )

    clusters = pd.DataFrame.from_records(
        rows,
        columns=config.CLUSTER_EXPORT_COLUMNS,
    )
    clusters["cluster_id"] = clusters["cluster_id"].astype("int64")
    clusters["n_nodes"] = clusters["n_nodes"].astype("int64")
    clusters["n_seed"] = clusters["n_seed"].astype("int64")

    isolate_cluster_sizes = result.loc[
        result["gid"].isin(nx.isolates(graph)), "cluster_id"
    ].map(clusters.set_index("cluster_id")["n_nodes"])
    if not isolate_cluster_sizes.eq(config.ONE).all():
        raise ValueError("Every isolated graph node must form its own community")

    return result, clusters


def build_cluster_hypothesis(
    role_counts: dict[str, int],
    n_seed: int,
    n_nodes: int,
) -> str:
    """Describe a cluster pattern without asserting criminal purpose."""
    consolidator_count = role_counts.get("consolidator", config.ZERO)
    if (
        n_seed >= config.CLUSTER_SEED_HYPOTHESIS_MIN
        and consolidator_count > config.ZERO
    ):
        return (
            "Признаки сбора средств нескольких seed: "
            f"{n_seed} seed; consolidator={consolidator_count}"
        )

    coordinator_count = role_counts.get("coordinator", config.ZERO)
    distributor_count = role_counts.get("distributor", config.ZERO)
    if coordinator_count > config.ZERO and distributor_count > config.ZERO:
        return (
            "Признаки распределительной сети: "
            f"coordinator={coordinator_count}, distributor={distributor_count}"
        )

    terminal_count = role_counts.get("terminal", config.ZERO)
    if terminal_count / n_nodes > config.CLUSTER_ROLE_MAJORITY_SHARE:
        return f"Признаки конечного оседания средств: terminal={terminal_count}/{n_nodes}"

    boundary_count = role_counts.get("boundary", config.ZERO)
    if boundary_count / n_nodes > config.CLUSTER_ROLE_MAJORITY_SHARE:
        return f"Граница выгрузки: boundary={boundary_count}/{n_nodes}; структура неполна"

    return f"Выраженная функция не выявлена: размер кластера — {n_nodes}."
