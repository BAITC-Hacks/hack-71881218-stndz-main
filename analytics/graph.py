"""Directed graph construction and graph-foundation invariants."""

from dataclasses import dataclass

import networkx as nx
import numpy as np
import pandas as pd

from analytics import config


@dataclass(frozen=True)
class GraphContext:
    graph: nx.DiGraph
    component_ids: dict[int, int]
    component_sizes: dict[int, int]
    predecessors: dict[int, tuple[int, ...]]
    successors: dict[int, tuple[int, ...]]
    edge_component_sizes: tuple[int, ...]


def build_graph(nodes: pd.DataFrame, edges: pd.DataFrame) -> GraphContext:
    """Build a directed weighted graph while preserving every listed node."""
    graph = nx.DiGraph()
    graph.add_nodes_from(sorted(nodes["gid"].astype("int64")))
    for row in edges.sort_values(["src", "dst"], kind="mergesort").itertuples(index=False):
        graph.add_edge(
            int(row.src),
            int(row.dst),
            sum_kzt=float(row.sum_kzt),
            n_tx=int(row.n_tx),
            depth=int(row.depth),
        )

    if graph.number_of_nodes() != config.EXPECTED_NODE_COUNT:
        raise ValueError(
            f"Graph must contain {config.EXPECTED_NODE_COUNT} nodes; "
            f"found {graph.number_of_nodes()}"
        )

    isolated_nodes = tuple(nx.isolates(graph))
    if len(isolated_nodes) != config.EXPECTED_ISOLATED_COUNT:
        raise ValueError(
            f"Graph must contain {config.EXPECTED_ISOLATED_COUNT} isolated nodes; "
            f"found {len(isolated_nodes)}"
        )

    node_depths = nodes.set_index("gid")["depth"].to_dict()
    boundary_nodes = {
        int(gid) for gid, depth in node_depths.items() if int(depth) == config.BOUNDARY_DEPTH
    }
    boundary_with_outgoing = [gid for gid in boundary_nodes if graph.out_degree(gid) != config.ZERO]
    if len(boundary_nodes) != config.EXPECTED_BOUNDARY_NODE_COUNT:
        raise ValueError(
            f"Expected {config.EXPECTED_BOUNDARY_NODE_COUNT} depth-4 nodes; "
            f"found {len(boundary_nodes)}"
        )
    if boundary_with_outgoing:
        raise ValueError(
            f"Found {len(boundary_with_outgoing)} depth-4 nodes with outgoing edges"
        )

    components = sorted(
        nx.weakly_connected_components(graph),
        key=lambda members: min(members),
    )
    component_ids: dict[int, int] = {}
    component_sizes: dict[int, int] = {}
    for component_id, members in enumerate(components):
        component_size = len(members)
        component_sizes[component_id] = component_size
        for gid in members:
            component_ids[gid] = component_id

    incident_nodes = set(graph.nodes) - set(isolated_nodes)
    edge_components = sorted(
        nx.weakly_connected_components(graph.subgraph(incident_nodes)),
        key=len,
        reverse=True,
    )
    edge_component_sizes = tuple(len(members) for members in edge_components)
    expected_largest_sizes = (
        config.EXPECTED_LARGEST_EDGE_COMPONENT_SIZE,
        config.EXPECTED_SECOND_LARGEST_EDGE_COMPONENT_SIZE,
    )
    if len(edge_components) != config.EXPECTED_EDGE_COMPONENT_COUNT:
        raise ValueError(
            f"Expected {config.EXPECTED_EDGE_COMPONENT_COUNT} components with edges; "
            f"found {len(edge_components)}"
        )
    if len(components) != config.EXPECTED_TOTAL_COMPONENT_COUNT:
        raise ValueError(
            f"Expected {config.EXPECTED_TOTAL_COMPONENT_COUNT} total components; "
            f"found {len(components)}"
        )
    if edge_component_sizes[: len(expected_largest_sizes)] != expected_largest_sizes:
        raise ValueError(
            "Largest edge component sizes do not match the audited data: "
            f"{edge_component_sizes[:len(expected_largest_sizes)]}"
        )

    predecessors = {
        gid: tuple(sorted(graph.predecessors(gid)))
        for gid in graph.nodes
    }
    successors = {
        gid: tuple(sorted(graph.successors(gid)))
        for gid in graph.nodes
    }

    return GraphContext(
        graph=graph,
        component_ids=component_ids,
        component_sizes=component_sizes,
        predecessors=predecessors,
        successors=successors,
        edge_component_sizes=edge_component_sizes,
    )


def build_foundation_features(nodes: pd.DataFrame, context: GraphContext) -> pd.DataFrame:
    """Add graph degrees, flows, and component membership to the node table."""
    graph = context.graph
    features = nodes[["gid", "depth", "is_seed"]].copy()
    features["gid"] = features["gid"].astype("int64")

    weighted_metrics = {
        "in_deg": graph.in_degree(),
        "out_deg": graph.out_degree(),
        "in_kzt": graph.in_degree(weight="sum_kzt"),
        "out_kzt": graph.out_degree(weight="sum_kzt"),
        "in_tx": graph.in_degree(weight="n_tx"),
        "out_tx": graph.out_degree(weight="n_tx"),
    }
    for column, metric in weighted_metrics.items():
        values = dict(metric)
        features[column] = features["gid"].map(values).fillna(config.ZERO)

    for column in ("in_deg", "out_deg", "in_tx", "out_tx"):
        features[column] = features[column].astype("int64")
    for column in ("in_kzt", "out_kzt"):
        features[column] = features[column].astype("float64")

    positive_inflow = features["in_kzt"].where(features["in_kzt"].ne(config.ZERO_FLOAT))
    features["pass_through"] = features["out_kzt"].div(positive_inflow)
    features["ext_inflow"] = np.maximum(
        config.ZERO_FLOAT,
        features["out_kzt"] - features["in_kzt"],
    )
    features["component_id"] = features["gid"].map(context.component_ids).astype("int64")
    features["component_size"] = features["component_id"].map(context.component_sizes).astype("int64")
    features["truncated_by_depth"] = features["depth"].eq(config.BOUNDARY_DEPTH) & features[
        "out_deg"
    ].eq(config.ZERO)

    return features.sort_values("gid", kind="mergesort").reset_index(drop=True)
