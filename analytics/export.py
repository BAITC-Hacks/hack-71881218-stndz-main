"""CSV and JSON exports for the graph intelligence engine."""

import json
from datetime import datetime, timezone
from math import fsum
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from analytics import config
from analytics.evidence import quality_flags_for_node
from analytics.graph import GraphContext


def write_csv_exports(
    nodes_roles: pd.DataFrame,
    clusters: pd.DataFrame,
    top_nodes: pd.DataFrame,
    output_dir: Path,
) -> None:
    """Write the three CSV artifacts with stable ordering and encoding."""
    output_dir.mkdir(parents=True, exist_ok=True)
    nodes_roles.to_csv(
        output_dir / "nodes_roles.csv",
        columns=config.NODE_ROLE_COLUMNS,
        index=False,
        encoding=config.CSV_ENCODING,
        lineterminator=config.CSV_LINE_TERMINATOR,
    )
    clusters.to_csv(
        output_dir / "clusters.csv",
        columns=config.CLUSTER_EXPORT_COLUMNS,
        index=False,
        encoding=config.CSV_ENCODING,
        lineterminator=config.CSV_LINE_TERMINATOR,
    )
    top_nodes.to_csv(
        output_dir / "top_nodes.csv",
        columns=config.TOP_NODE_EXPORT_COLUMNS,
        index=False,
        encoding=config.CSV_ENCODING,
        lineterminator=config.CSV_LINE_TERMINATOR,
    )


def _json_value(value: Any) -> Any:
    if pd.isna(value):
        return None
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.isoformat()
    return value


def _feature_lookup(nodes_roles: pd.DataFrame) -> dict[int, dict[str, Any]]:
    return {
        int(row["gid"]): row
        for row in nodes_roles.to_dict(orient="records")
    }


def build_graph_payload(
    nodes_roles: pd.DataFrame,
    clusters: pd.DataFrame,
    top_nodes: pd.DataFrame,
    edges: pd.DataFrame,
    transactions: pd.DataFrame,
    context: GraphContext,
) -> dict[str, Any]:
    """Build a contract-shaped graph payload from the same rows as the CSV."""
    if context.graph.number_of_nodes() != len(nodes_roles) or context.graph.number_of_edges() != len(edges):
        raise ValueError("Graph and export tables do not describe the same input data")
    if nodes_roles["gid"].isna().any() or nodes_roles["gid"].duplicated().any():
        raise ValueError("Node export must contain unique, non-null gids")
    if set(nodes_roles["gid"]) != set(context.graph.nodes):
        raise ValueError("Node export and graph must contain the same gids")

    role_rows = _feature_lookup(nodes_roles)
    if set(nodes_roles["cluster_id"]) != set(clusters["cluster_id"]):
        raise ValueError("Node and cluster exports do not share the same cluster IDs")
    if top_nodes["gid"].isna().any() or top_nodes["gid"].duplicated().any():
        raise ValueError("Top-node export must contain unique, non-null gids")
    if not set(top_nodes["gid"].astype("int64")).issubset(role_rows):
        raise ValueError("Top-node export contains gids missing from node exports")
    rank_by_gid = {
        int(row.gid): int(row.rank)
        for row in top_nodes.itertuples(index=False)
    }
    transaction_dates = (
        transactions.groupby(["src", "dst"], as_index=False, sort=True)
        .agg(first_date=("date", "min"), last_date=("date", "max"))
    )
    edges_with_dates = edges.merge(
        transaction_dates,
        on=["src", "dst"],
        how="left",
        validate="one_to_one",
    ).sort_values(["src", "dst"], kind="mergesort")

    json_nodes = []
    for gid, row in sorted(role_rows.items()):
        metrics = {
            key: _json_value(row[key])
            for key in (
                "in_deg",
                "out_deg",
                "in_kzt",
                "out_kzt",
                "in_tx",
                "out_tx",
                "pass_through",
                "ext_inflow",
                "seed_payers",
                "seed_reach2",
                "pagerank",
                "betweenness",
                "fast_share",
                "sync_in_max",
            )
        }
        flags = quality_flags_for_node(row)

        json_nodes.append(
            {
                "gid": str(gid),
                "depth": _json_value(row["depth"]),
                "is_seed": _json_value(row["is_seed"]),
                "role": row["role"],
                "role_score": _json_value(row["role_score"]),
                "cluster_id": _json_value(row["cluster_id"]),
                "priority_score": _json_value(row["priority_score"]),
                "rank": rank_by_gid.get(gid),
                "evidence": row["evidence"],
                "metrics": metrics,
                "flags": flags,
            }
        )

    json_edges = [
        {
            "src": str(int(row.src)),
            "dst": str(int(row.dst)),
            "sum_kzt": float(row.sum_kzt),
            "n_tx": int(row.n_tx),
            "first_date": row.first_date.date().isoformat(),
            "last_date": row.last_date.date().isoformat(),
        }
        for row in edges_with_dates.itertuples(index=False)
    ]

    # Preserve individual transfers (including identical rows) in a stable order.
    # Both the static UI and the API consume this same analytical snapshot.
    ordered_transactions = transactions.sort_values(
        ["date", "src", "dst", "sum_kzt"], ascending=[False, True, True, True], kind="mergesort"
    )
    json_transactions = [
        {
            "src": str(int(row.src)),
            "dst": str(int(row.dst)),
            "date": row.date.date().isoformat(),
            "sum_kzt": float(row.sum_kzt),
        }
        for row in ordered_transactions.itertuples(index=False)
    ]

    json_clusters = []
    for cluster in clusters.itertuples(index=False):
        members = nodes_roles.loc[nodes_roles["cluster_id"] == cluster.cluster_id]
        role_counts = members["role"].value_counts().to_dict()
        role_mix = {
            role: int(role_counts[role])
            for role in config.ROLE_NAMES
            if role in role_counts
        }
        top_gids = (
            cluster.top_gids.split(config.CLUSTER_GID_SEPARATOR)
            if cluster.top_gids
            else []
        )
        json_clusters.append(
            {
                "cluster_id": int(cluster.cluster_id),
                "n_nodes": int(cluster.n_nodes),
                "n_seed": int(cluster.n_seed),
                "sum_kzt_internal": float(cluster.sum_kzt_internal),
                "top_gids": top_gids,
                "hypothesis": cluster.hypothesis,
                "role_mix": role_mix,
            }
        )

    return {
        "meta": {
            "nodes": len(nodes_roles),
            "edges": len(edges),
            "tx": len(transactions),
            "seeds": int(nodes_roles["is_seed"].sum()),
            "total_kzt": fsum(edges["sum_kzt"]),
            "clusters": len(json_clusters),
            "date_from": transactions["date"].min().date().isoformat() if json_transactions else None,
            "date_to": transactions["date"].max().date().isoformat() if json_transactions else None,
            "generated_at": datetime.now(timezone.utc).replace(microsecond=config.ZERO).isoformat(),
        },
        "nodes": json_nodes,
        "edges": json_edges,
        "clusters": json_clusters,
        "transactions": json_transactions,
    }


def write_graph_json(payload: dict[str, Any], output_dir: Path) -> None:
    """Serialize the graph payload as strict UTF-8 JSON."""
    output_dir.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        indent=config.JSON_INDENT,
        allow_nan=False,
    )
    (output_dir / "graph.json").write_text(
        serialized + config.CSV_LINE_TERMINATOR,
        encoding=config.JSON_ENCODING,
    )
