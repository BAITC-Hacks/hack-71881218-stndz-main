import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

from analytics import config


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def export_dir(tmp_path_factory):
    output_dir = tmp_path_factory.mktemp("graph-contract")
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "run_pipeline.py"),
            "--data-dir",
            str(ROOT / config.DATA_DIR),
            "--output-dir",
            str(output_dir),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return output_dir


@pytest.fixture(scope="module")
def exported(export_dir):
    output_dir = export_dir
    roles = pd.read_csv(output_dir / "nodes_roles.csv", dtype={"gid": "int64"})
    clusters = pd.read_csv(output_dir / "clusters.csv")
    top = pd.read_csv(output_dir / "top_nodes.csv", dtype={"gid": "int64"})
    payload = json.loads(
        (output_dir / "graph.json").read_text(encoding="utf-8"),
        parse_constant=_reject_json_constant,
    )
    return roles, clusters, top, payload


def _reject_json_constant(value: str):
    raise ValueError(f"Invalid JSON constant: {value}")


def test_csv_contract_schema_and_values(exported):
    roles, clusters, top, _ = exported

    assert tuple(roles.columns) == config.NODE_ROLE_COLUMNS
    assert tuple(clusters.columns) == config.CLUSTER_EXPORT_COLUMNS
    assert tuple(top.columns) == config.TOP_NODE_EXPORT_COLUMNS
    assert len(roles) == config.EXPECTED_NODE_COUNT
    assert roles.gid.is_unique
    assert roles.role.isin(config.ROLE_NAMES).all()
    assert roles.role_score.between(config.ROLE_SCORE_MIN, config.ROLE_SCORE_MAX).all()
    assert roles.priority_score.between(config.ZERO_FLOAT, config.ONE_FLOAT).all()
    assert roles.evidence.str.len().le(config.EVIDENCE_MAX_CHARACTERS).all()
    assert roles.evidence.str.contains(r"\d").all()
    assert clusters.n_nodes.sum() == config.EXPECTED_NODE_COUNT
    assert top.priority_score.is_monotonic_decreasing


def test_graph_json_matches_csv_and_preserves_gid(exported):
    roles, clusters, top, payload = exported
    nodes_by_gid = {int(node["gid"]): node for node in payload["nodes"]}

    assert payload["meta"]["nodes"] == len(roles)
    assert payload["meta"]["clusters"] == len(clusters)
    assert len(nodes_by_gid) == len(roles)
    assert set(nodes_by_gid) == set(roles.gid)

    largest_gid = int(roles.gid.max())
    assert all(isinstance(node["gid"], str) for node in payload["nodes"])
    assert nodes_by_gid[largest_gid]["gid"] == str(largest_gid)

    roles_by_gid = roles.set_index("gid")
    for gid, node in nodes_by_gid.items():
        csv_row = roles_by_gid.loc[gid]
        assert node["role"] == csv_row.role
        assert node["cluster_id"] == csv_row.cluster_id
        assert node["role_score"] == pytest.approx(csv_row.role_score)
        assert node["priority_score"] == pytest.approx(csv_row.priority_score)

    ranks_by_gid = dict(zip(top.gid, top["rank"], strict=True))
    assert {gid: node["rank"] for gid, node in nodes_by_gid.items() if node["rank"] is not None} == ranks_by_gid
    assert sum(cluster["n_nodes"] for cluster in payload["clusters"]) == len(roles)


def test_json_metrics_nulls_edges_and_cluster_summaries_match_csv(exported):
    roles, clusters, top, payload = exported
    roles_by_gid = roles.set_index("gid")
    known_gids = set(roles.gid.astype(str))
    for node in payload["nodes"]:
        csv_row = roles_by_gid.loc[int(node["gid"])]
        assert node["evidence"] == csv_row.evidence
        assert node["depth"] == csv_row.depth
        assert node["is_seed"] == csv_row.is_seed
        assert {"pass_through", "fast_share", "sync_in_max"} <= set(node["metrics"])
        for metric, value in node["metrics"].items():
            expected = csv_row[metric]
            if pd.isna(expected):
                assert value is None
            else:
                assert value == pytest.approx(expected)

    assert len(payload["edges"]) == config.EXPECTED_EDGE_COUNT
    assert len({(edge["src"], edge["dst"]) for edge in payload["edges"]}) == len(
        payload["edges"]
    )
    for edge in payload["edges"]:
        assert isinstance(edge["src"], str) and edge["src"] in known_gids
        assert isinstance(edge["dst"], str) and edge["dst"] in known_gids

    clusters_by_id = clusters.set_index("cluster_id")
    for cluster in payload["clusters"]:
        csv_row = clusters_by_id.loc[cluster["cluster_id"]]
        assert cluster["n_nodes"] == csv_row.n_nodes
        assert cluster["n_seed"] == csv_row.n_seed
        assert cluster["sum_kzt_internal"] == pytest.approx(csv_row.sum_kzt_internal)
        assert cluster["hypothesis"] == csv_row.hypothesis
        assert cluster["top_gids"] == csv_row.top_gids.split(config.CLUSTER_GID_SEPARATOR)
        members = roles.loc[roles.cluster_id.eq(cluster["cluster_id"])]
        assert cluster["role_mix"] == members.role.value_counts().to_dict()
        assert set(cluster["top_gids"]) <= set(members.gid.astype(str))

    assert top["rank"].tolist() == list(range(1, config.TOP_NODE_COUNT + 1))
    for row in top.itertuples(index=False):
        assert row.role == roles_by_gid.loc[row.gid, "role"]
        assert row.priority_score == pytest.approx(
            roles_by_gid.loc[row.gid, "priority_score"]
        )


def test_pipeline_outputs_ignore_input_row_order(export_dir, tmp_path):
    data_dir = tmp_path / "shuffled-data"
    data_dir.mkdir()
    for filename in (config.NODES_FILE, config.EDGES_FILE, config.TRANSACTIONS_FILE):
        frame = pd.read_parquet(ROOT / config.DATA_DIR / filename)
        frame.sample(frac=1, random_state=42).to_parquet(
            data_dir / filename, index=False
        )
    output_dir = tmp_path / "output"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "run_pipeline.py"),
            "--data-dir",
            str(data_dir),
            "--output-dir",
            str(output_dir),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    for filename in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv"):
        assert (output_dir / filename).read_bytes() == (export_dir / filename).read_bytes()
    original = json.loads((export_dir / "graph.json").read_text(encoding="utf-8"))
    reordered = json.loads((output_dir / "graph.json").read_text(encoding="utf-8"))
    original["meta"].pop("generated_at")
    reordered["meta"].pop("generated_at")
    assert original == reordered
