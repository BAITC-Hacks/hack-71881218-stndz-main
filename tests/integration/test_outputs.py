"""Проверки выгрузок по ТЗ (must-have 1, 2, 4, 5) и плану команды, раздел 6.2.

Пайплайн запускается во временную папку, данные фронта не трогаются.
Запуск: python -m pytest tests/integration -v

Какой пайплайн проверять, задаёт переменная MONEYGRAPH_PIPELINE:
  engine (по умолчанию) — run_pipeline.py + analytics/ (участник 1), официальный пайплайн
  legacy                — прежний pipeline.py
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# словарь ТЗ + boundary — задокументированное расширение из плана (раздел 4.3)
ALLOWED_ROLES = {
    "consolidator", "transit", "distributor", "terminal",
    "coordinator", "peripheral", "boundary",
}
MAX_SECONDS = 300

PIPELINE = os.environ.get("MONEYGRAPH_PIPELINE", "engine")
COMMANDS = {
    "legacy": lambda dest: [
        str(ROOT / "pipeline.py"), "--data", str(DATA), "--out", str(dest / "out"),
        "--frontend", str(dest / "frontend"), "--no-viz"],
    "engine": lambda dest: [
        str(ROOT / "run_pipeline.py"), "--data-dir", str(DATA), "--output-dir", str(dest / "out")],
}
if PIPELINE not in COMMANDS:
    raise ValueError(f"MONEYGRAPH_PIPELINE={PIPELINE!r}, ожидается одно из {sorted(COMMANDS)}")


def run_pipeline(dest: Path) -> float:
    start = time.monotonic()
    subprocess.run(
        [sys.executable, *COMMANDS[PIPELINE](dest)],
        cwd=ROOT, check=True, capture_output=True,
    )
    return time.monotonic() - start


@pytest.fixture(scope="session")
def run(tmp_path_factory):
    dest = tmp_path_factory.mktemp("run1")
    elapsed = run_pipeline(dest)
    return dest / "out", elapsed


@pytest.fixture(scope="session")
def roles(run):
    return pd.read_csv(run[0] / "nodes_roles.csv", dtype={"gid": "int64"})


@pytest.fixture(scope="session")
def clusters(run):
    return pd.read_csv(run[0] / "clusters.csv")


@pytest.fixture(scope="session")
def top(run):
    return pd.read_csv(run[0] / "top_nodes.csv", dtype={"gid": "int64"})


@pytest.fixture(scope="session")
def nodes():
    return pd.read_parquet(DATA / "nodes.parquet")


@pytest.fixture(scope="session")
def edges():
    return pd.read_parquet(DATA / "edges.parquet")


# ---------------------------------------------------------------- must-have 1

def test_runs_under_time_limit(run):
    assert run[1] < MAX_SECONDS, f"пайплайн шёл {run[1]:.0f} с"


def test_three_outputs_exist(run):
    for name in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv"):
        assert (run[0] / name).is_file(), name


def test_deterministic(run, tmp_path_factory):
    dest = tmp_path_factory.mktemp("run2")
    run_pipeline(dest)
    for name in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv"):
        a = (run[0] / name).read_bytes()
        b = (dest / "out" / name).read_bytes()
        assert a == b, f"{name} отличается между двумя запусками"


# ---------------------------------------------------------------- must-have 2

def test_nodes_roles_covers_every_node(roles, nodes):
    assert len(roles) == 2248
    assert roles.gid.is_unique
    assert set(roles.gid) == set(nodes.gid)


def test_nodes_roles_columns_filled(roles):
    required = ["gid", "role", "role_score", "cluster_id", "priority_score", "evidence"]
    missing = [c for c in required if c not in roles.columns]
    assert not missing, f"нет колонок: {missing}"
    assert roles[required].notna().all().all()


def test_roles_from_dictionary(roles):
    bad = roles[~roles.role.isin(ALLOWED_ROLES)]
    found = bad.role.fillna("<пусто>").value_counts().to_dict()
    assert bad.empty, f"{len(bad)} узлов с ролью вне словаря: {found}"


def test_scores_in_unit_range(roles):
    assert roles.role_score.between(0, 1).all()
    assert roles.priority_score.between(0, 1).all()


def test_evidence_readable(roles):
    ev = roles.evidence.astype(str)
    assert (ev.str.strip().str.len() > 0).all(), "пустой evidence"
    assert (ev.str.len() <= 200).all(), "evidence длиннее 200 символов"
    no_digits = roles[~ev.str.contains(r"\d")]
    assert no_digits.empty, f"{len(no_digits)} evidence без чисел, пример: {no_digits.evidence.iloc[0]!r}"


# ---------------------------------------------------------------- ловушки данных

def test_truncated_nodes_not_terminal(roles, nodes, edges):
    """444 узла на 4-м колене без исходящих — срез обхода, а не конечные получатели."""
    truncated = set(nodes[nodes.depth == 4].gid) - set(edges.src)
    assert len(truncated) == 444
    wrong = roles[roles.gid.isin(truncated) & (roles.role == "terminal")]
    assert wrong.empty, f"{len(wrong)} обрезанных узлов помечены terminal"


def test_seed_not_transit(roles, nodes):
    """У seed входящие неполные, pass_through для них некорректен."""
    seeds = set(nodes[nodes.is_seed].gid)
    wrong = roles[roles.gid.isin(seeds) & (roles.role == "transit")]
    assert wrong.empty, f"{len(wrong)} seed помечены transit"


# ---------------------------------------------------------------- must-have 4

def test_clusters_schema(clusters):
    required = ["cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"]
    missing = [c for c in required if c not in clusters.columns]
    assert not missing, f"нет колонок: {missing}"
    assert clusters.cluster_id.is_unique
    assert clusters.hypothesis.astype(str).str.strip().str.len().gt(0).all()


def test_clusters_cover_all_nodes(clusters, roles):
    assert clusters.n_nodes.sum() == 2248
    assert set(roles.cluster_id) <= set(clusters.cluster_id)


def test_cluster_seed_counts_match(clusters, roles, nodes):
    seeds = set(nodes[nodes.is_seed].gid)
    per_cluster = roles[roles.gid.isin(seeds)].groupby("cluster_id").size()
    got = clusters.set_index("cluster_id").n_seed
    assert (got.reindex(per_cluster.index) == per_cluster).all()
    assert got.sum() == 81


# ---------------------------------------------------------------- must-have 5

def test_top_nodes(top, roles):
    required = ["rank", "gid", "role", "priority_score", "why"]
    missing = [c for c in required if c not in top.columns]
    assert not missing, f"нет колонок: {missing}"
    assert len(top) >= 20
    assert list(top["rank"]) == list(range(1, len(top) + 1))
    assert top.priority_score.is_monotonic_decreasing
    assert top.why.astype(str).str.strip().str.len().gt(0).all()
    assert set(top.gid) <= set(roles.gid)
