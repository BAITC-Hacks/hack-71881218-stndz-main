import json
from pathlib import Path

import networkx as nx
import pandas as pd
import pytest

from analytics import config
from analytics.clusters import assign_communities, build_cluster_hypothesis
from analytics.evidence import add_role_evidence
from analytics.export import add_pending_priority_field, build_graph_payload
from analytics.features import add_structural_features
from analytics.graph import build_foundation_features, build_graph
from analytics.loader import load_data, validate_data
from analytics.roles import assign_roles


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def graph_artifacts():
    nodes, edges, transactions = load_data(ROOT / config.DATA_DIR)
    validate_data(nodes, edges, transactions)
    context = build_graph(nodes, edges)
    features = build_foundation_features(nodes, context)
    features = add_structural_features(features, context)
    nodes_roles = add_role_evidence(assign_roles(features))
    nodes_roles = add_pending_priority_field(nodes_roles)
    nodes_roles, clusters = assign_communities(nodes_roles, edges, context.graph)
    return nodes_roles, clusters, edges, transactions, context


@pytest.mark.parametrize(
    ("role_counts", "n_seed", "n_nodes", "expected"),
    [
        (
            {"consolidator": 1, "terminal": 3},
            2,
            4,
            "Признаки сбора средств нескольких seed: 2 seed; consolidator=1",
        ),
        (
            {"coordinator": 1, "distributor": 1},
            1,
            2,
            "Признаки распределительной сети: coordinator=1, distributor=1",
        ),
        (
            {"terminal": 3, "boundary": 1},
            0,
            4,
            "Признаки конечного оседания средств: terminal=3/4",
        ),
        (
            {"boundary": 3, "terminal": 1},
            0,
            4,
            "Граница выгрузки: boundary=3/4; структура неполна",
        ),
        (
            {"terminal": 1, "boundary": 1},
            0,
            2,
            "Выраженная функция не выявлена: размер кластера — 2.",
        ),
    ],
)
def test_cluster_hypothesis_precedence_and_counts(
    role_counts: dict[str, int],
    n_seed: int,
    n_nodes: int,
    expected: str,
) -> None:
    hypothesis = build_cluster_hypothesis(role_counts, n_seed, n_nodes)

    assert hypothesis == expected
    assert len(hypothesis) <= config.EVIDENCE_MAX_CHARACTERS
    assert any(character.isdigit() for character in hypothesis)


def test_communities_cover_graph_and_match_audited_counts(graph_artifacts) -> None:
    nodes_roles, clusters, _, _, context = graph_artifacts

    assert len(nodes_roles) == config.EXPECTED_NODE_COUNT
    assert nodes_roles["gid"].is_unique
    assert nodes_roles["cluster_id"].notna().all()
    assert clusters["cluster_id"].is_unique
    assert len(clusters) == config.EXPECTED_COMMUNITY_COUNT
    assert int((clusters["n_seed"] > config.ONE).sum()) == (
        config.EXPECTED_MULTI_SEED_COMMUNITY_COUNT
    )
    assert int(clusters["n_nodes"].sum()) == config.EXPECTED_NODE_COUNT
    assert clusters["hypothesis"].str.strip().ne("").all()

    cluster_sizes = clusters.set_index("cluster_id")["n_nodes"]
    node_clusters = nodes_roles.set_index("gid")["cluster_id"]
    isolated_gids = tuple(nx.isolates(context.graph))
    assert len(isolated_gids) == config.EXPECTED_ISOLATED_COUNT
    assert node_clusters.loc[list(isolated_gids)].map(cluster_sizes).eq(config.ONE).all()


def test_cluster_flow_top_gids_and_csv_are_deterministic(graph_artifacts) -> None:
    nodes_roles, clusters, edges, _, context = graph_artifacts
    cluster_by_gid = nodes_roles.set_index("gid")["cluster_id"]
    edge_clusters = edges.assign(
        src_cluster=edges["src"].map(cluster_by_gid),
        dst_cluster=edges["dst"].map(cluster_by_gid),
    )
    expected_flow = (
        edge_clusters.loc[edge_clusters["src_cluster"].eq(edge_clusters["dst_cluster"])]
        .groupby("src_cluster", sort=True)["sum_kzt"]
        .sum()
    )
    actual_flow = clusters.set_index("cluster_id")["sum_kzt_internal"]
    pd.testing.assert_series_equal(
        actual_flow.sort_index(),
        expected_flow.reindex(actual_flow.index, fill_value=config.ZERO_FLOAT)
        .sort_index()
        .rename("sum_kzt_internal"),
        check_dtype=False,
    )

    for cluster in clusters.itertuples(index=False):
        members = nodes_roles.loc[nodes_roles["cluster_id"].eq(cluster.cluster_id)]
        expected_top_gids = (
            members.sort_values(
                ["priority_score", "gid"],
                ascending=[False, True],
                kind="mergesort",
            )
            .head(config.CLUSTER_TOP_GID_COUNT)["gid"]
            .astype("int64")
            .astype(str)
            .tolist()
        )
        assert cluster.top_gids.split(config.CLUSTER_GID_SEPARATOR) == expected_top_gids

    _, repeated_clusters = assign_communities(nodes_roles, edges, context.graph)
    csv_options = {
        "columns": config.CLUSTER_EXPORT_COLUMNS,
        "index": False,
        "lineterminator": config.CSV_LINE_TERMINATOR,
    }
    assert clusters.to_csv(**csv_options).encode(config.CSV_ENCODING) == (
        repeated_clusters.to_csv(**csv_options).encode(config.CSV_ENCODING)
    )


def test_graph_json_exports_cluster_contract(graph_artifacts) -> None:
    nodes_roles, clusters, edges, transactions, context = graph_artifacts

    payload = build_graph_payload(nodes_roles, clusters, edges, transactions, context)
    json.dumps(payload, allow_nan=False)

    assert payload["meta"]["clusters"] == config.EXPECTED_COMMUNITY_COUNT
    assert len(payload["clusters"]) == len(clusters)
    assert all(isinstance(node["gid"], str) for node in payload["nodes"])
    for cluster in payload["clusters"]:
        assert all(isinstance(gid, str) for gid in cluster["top_gids"])
        assert len(cluster["top_gids"]) <= config.CLUSTER_TOP_GID_COUNT
        assert sum(cluster["role_mix"].values()) == cluster["n_nodes"]
        assert any(character.isdigit() for character in cluster["hypothesis"])
