"""Structural and monetary graph features."""

import networkx as nx
import numpy as np
import pandas as pd

from analytics import config
from analytics.graph import GraphContext


def add_structural_features(
    features: pd.DataFrame,
    context: GraphContext,
) -> pd.DataFrame:
    """Add P0 structural features while keeping undefined pass-through explicit."""
    if context.graph.number_of_nodes() != len(features):
        raise ValueError("Feature table and graph must contain the same nodes")

    result = features.copy()
    seed_gids = set(result.loc[result["is_seed"], "gid"].astype("int64"))

    result["seed_payers"] = result["gid"].map(
        {
            gid: sum(predecessor in seed_gids for predecessor in context.predecessors[gid])
            for gid in result["gid"]
        }
    ).astype("int64")

    seed_reach = {}
    for gid in result["gid"]:
        frontier = {int(gid)}
        reached_seeds = set()
        for _ in range(config.SEED_REACH_DISTANCE):
            frontier = {
                predecessor
                for current_gid in frontier
                for predecessor in context.predecessors[current_gid]
            }
            reached_seeds.update(frontier & seed_gids)
        seed_reach[int(gid)] = len(reached_seeds)
    result["seed_reach2"] = result["gid"].map(seed_reach).astype("int64")

    pagerank = nx.pagerank(context.graph, weight="sum_kzt")
    betweenness = nx.betweenness_centrality(context.graph)
    result["pagerank"] = result["gid"].map(pagerank).astype("float64")
    result["betweenness"] = result["gid"].map(betweenness).astype("float64")

    result["retention"] = (config.ONE_FLOAT - result["pass_through"]).fillna(
        config.ZERO_FLOAT
    )

    unobserved_inflow_count = int(result["pass_through"].isna().sum())
    if unobserved_inflow_count != config.EXPECTED_UNOBSERVED_INFLOW_COUNT:
        raise ValueError(
            "Unexpected number of nodes with undefined pass_through: "
            f"{unobserved_inflow_count}"
        )

    numeric_columns = result.select_dtypes(include="number").columns.drop("pass_through")
    finite_values = result[numeric_columns].to_numpy(dtype="float64")
    if not np.isfinite(finite_values).all():
        raise ValueError("Structural features contain non-finite values")

    unexpected_nan_columns = [
        column
        for column in result.columns[result.isna().any()]
        if column != "pass_through"
    ]
    if unexpected_nan_columns:
        raise ValueError(
            "Only pass_through may contain NaN; found values in: "
            f"{', '.join(unexpected_nan_columns)}"
        )

    return result.sort_values("gid", kind="mergesort").reset_index(drop=True)
