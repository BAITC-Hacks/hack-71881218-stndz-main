"""Phase-one CSV and JSON scaffold exports."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from analytics import config
from analytics.graph import GraphContext


def make_placeholder_roles(features: pd.DataFrame) -> pd.DataFrame:
    """Create schema-complete rows with explicit placeholders for later phases."""
    result = features.copy()
    result["role"] = config.ROLE_PLACEHOLDER
    result["role_score"] = config.ROLE_SCORE_PLACEHOLDER
    result["cluster_id"] = config.CLUSTER_ID_PLACEHOLDER
    result["priority_score"] = config.PRIORITY_SCORE_PLACEHOLDER
    result["evidence"] = config.ROLE_PLACEHOLDER
    return result.loc[:, config.NODE_ROLE_COLUMNS]


def make_empty_exports() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return schema-only clusters and top-node tables for the scaffold phase."""
    clusters = pd.DataFrame(columns=config.CLUSTER_EXPORT_COLUMNS)
    top_nodes = pd.DataFrame(columns=config.TOP_NODE_EXPORT_COLUMNS)
    return clusters, top_nodes


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
    edges: pd.DataFrame,
    transactions: pd.DataFrame,
    context: GraphContext,
) -> dict[str, Any]:
    """Build a contract-shaped graph payload from the same rows as the CSV."""
    if context.graph.number_of_nodes() != len(nodes_roles) or context.graph.number_of_edges() != len(edges):
        raise ValueError("Graph and export tables do not describe the same input data")

    role_rows = _feature_lookup(nodes_roles)
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
            )
        }
        metrics.update(
            {
                "fast_share": None,
            }
        )
        flags = []
        if row["truncated_by_depth"]:
            flags.append("truncated_by_depth")
        if row["is_seed"]:
            flags.append("seed_inflow_incomplete")
        if row["out_kzt"] > row["in_kzt"]:
            flags.append("outflow_exceeds_inflow")
        if row["in_deg"] == config.ZERO and row["out_deg"] == config.ZERO:
            flags.append("isolated")
        if row["ext_inflow"] >= config.EXTERNAL_FUNDING_THRESHOLD_KZT:
            flags.append("external_funding")

        json_nodes.append(
            {
                "gid": str(gid),
                "depth": _json_value(row["depth"]),
                "is_seed": _json_value(row["is_seed"]),
                "role": row["role"],
                "role_score": _json_value(row["role_score"]),
                "cluster_id": _json_value(row["cluster_id"]),
                "priority_score": _json_value(row["priority_score"]),
                "rank": None,
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

    return {
        "meta": {
            "nodes": len(nodes_roles),
            "edges": len(edges),
            "tx": len(transactions),
            "seeds": int(nodes_roles["is_seed"].sum()),
            "total_kzt": float(edges["sum_kzt"].sum()),
            "clusters": config.ZERO,
            "generated_at": datetime.now(timezone.utc).replace(microsecond=config.ZERO).isoformat(),
        },
        "nodes": json_nodes,
        "edges": json_edges,
        "clusters": [],
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
