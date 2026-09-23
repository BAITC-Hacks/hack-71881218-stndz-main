import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

from analytics import config


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def exported(tmp_path_factory):
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
    roles = pd.read_csv(output_dir / "nodes_roles.csv", dtype={"gid": "int64"})
    clusters = pd.read_csv(output_dir / "clusters.csv")
    top = pd.read_csv(output_dir / "top_nodes.csv", dtype={"gid": "int64"})
    payload = json.loads((output_dir / "graph.json").read_text(encoding="utf-8"), parse_constant=_reject_json_constant)
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
    assert int(str(largest_gid)) == largest_gid
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

