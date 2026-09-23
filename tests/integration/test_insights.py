"""Карточка узла, оценка полноты данных и устойчивость сети (опциональные пункты ТЗ)."""

import json
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from backend.insights import node_card, resilience, times_phrase
from backend.main import app
from backend.store import ROOT, GraphStore

# a, s — seed; h — хаб; e — отдаёт больше, чем получил; x — граница выгрузки; s — изолирован
EDGES = [
    ("a", "h", 50_000), ("b", "h", 40_000), ("c", "h", 30_000), ("d", "h", 20_000),
    ("h", "r", 100_000), ("r", "x", 90_000), ("d", "e", 100_000), ("e", "r", 3_000_000),
]
LABELS = "abcdhrxse"


@pytest.fixture
def graph(tmp_path):
    ids = {label: str(10**17 + index) for index, label in enumerate(LABELS)}
    links = [{"source": ids[s], "target": ids[t], "sum_kzt": kzt, "n_tx": 1} for s, t, kzt in EDGES]
    nodes = []
    for label, gid in ids.items():
        incoming = [l for l in links if l["target"] == gid]
        outgoing = [l for l in links if l["source"] == gid]
        nodes.append({
            "id": gid, "role": "peripheral", "role_score": 0.5, "priority_score": 0.0,
            "cluster_id": 0, "evidence": "синтетика",
            "in_deg": len(incoming), "out_deg": len(outgoing),
            "in_kzt": sum(l["sum_kzt"] for l in incoming),
            "out_kzt": sum(l["sum_kzt"] for l in outgoing),
            "is_seed": label in "as", "depth": 4 if label == "x" else 1,
            "truncated_by_depth": label == "x",
            "betweenness": 0.9 if label == "h" else 0.1,
        })
    path = tmp_path / "graph.json"
    path.write_text(json.dumps({"meta": {}, "nodes": nodes, "links": links}), encoding="utf-8")
    return GraphStore.load(path), ids


def texts(items, key):
    return " ".join(item[key] for item in items)


# ---------------------------------------------------------------- карточка

def test_card_ranks_counterparties_by_amount_and_limits_to_three(graph):
    store, ids = graph
    card = node_card(store, ids["h"])
    assert [p["gid"] for p in card["top_payers"]] == [ids["a"], ids["b"], ids["c"]]
    assert card["top_payers"][0]["sum_kzt"] == 50_000
    assert [r["gid"] for r in card["top_receivers"]] == [ids["r"]]


def test_card_flags_external_source_of_funds(graph):
    store, ids = graph
    card = node_card(store, ids["e"])
    assert "30" in texts(card["attention"], "text")
    assert "вне выборки" in texts(card["attention"], "text")


@pytest.mark.parametrize("ratio,expected", [
    (30, "в 30 раз"), (23, "в 23 раза"), (21, "в 21 раз"), (12, "в 12 раз"), (2.5, "в 2,5 раза"),
])
def test_ratio_phrase_agrees_with_number(ratio, expected):
    assert times_phrase(ratio) == expected


def test_card_does_not_flag_node_that_received_more_than_sent(graph):
    store, ids = graph
    assert "вне выборки" not in texts(node_card(store, ids["r"])["attention"], "text")


def test_card_unknown_gid_raises(graph):
    store, _ = graph
    with pytest.raises(KeyError):
        node_card(store, "999999999999999999")


# ---------------------------------------------------------------- полнота данных

def test_gaps_boundary_node_asks_for_outgoing(graph):
    store, ids = graph
    gaps = node_card(store, ids["x"])["data_gaps"]
    assert "исходящие" in texts(gaps, "next_request").lower()


def test_gaps_seed_asks_for_incoming(graph):
    store, ids = graph
    gaps = node_card(store, ids["a"])["data_gaps"]
    assert "входящие" in texts(gaps, "next_request").lower()


def test_gaps_external_source_asks_for_interbank_incoming(graph):
    store, ids = graph
    gaps = node_card(store, ids["e"])["data_gaps"]
    assert "межбанков" in texts(gaps, "next_request").lower()


def test_gaps_isolated_node_asks_for_full_statement(graph):
    store, ids = graph
    gaps = node_card(store, ids["s"])["data_gaps"]
    assert "полную выписку" in texts(gaps, "next_request").lower()


def test_gaps_always_mention_threshold(graph):
    store, ids = graph
    for label in LABELS:
        assert "5 000" in texts(node_card(store, ids[label])["data_gaps"], "gap")


# ---------------------------------------------------------------- устойчивость

def test_resilience_removes_top_node_by_betweenness_when_no_priority(graph):
    store, ids = graph
    result = resilience(store, n=1)
    assert result["ranked_by"] == "betweenness"
    assert result["removed"] == [ids["h"]]
    assert result["before"] == {"components": 2, "largest": 8, "seeds_in_largest": 1}
    assert result["after"] == {"components": 5, "largest": 4, "seeds_in_largest": 0}


def test_resilience_prefers_priority_when_available(graph):
    store, ids = graph
    store.nodes[ids["r"]]["priority_score"] = 0.9
    result = resilience(store, n=1)
    assert result["ranked_by"] == "priority_score"
    assert result["removed"] == [ids["r"]]


# ---------------------------------------------------------------- API

@pytest.fixture
def client(graph, monkeypatch):
    store, ids = graph
    monkeypatch.setattr(GraphStore, "load", classmethod(lambda cls, path=None: store))
    with TestClient(app) as c:
        yield c, ids


def test_api_card(client):
    c, ids = client
    r = c.get(f"/api/nodes/{ids['e']}/card")
    assert r.status_code == 200
    assert r.json()["gid"] == ids["e"]


def test_api_card_unknown_gid_404(client):
    c, _ = client
    assert c.get("/api/nodes/999999999999999999/card").status_code == 404


@pytest.mark.parametrize("n", [0, 101])
def test_api_resilience_rejects_out_of_range(client, n):
    c, _ = client
    assert c.get(f"/api/resilience?n={n}").status_code == 422


def test_api_resilience(client):
    c, ids = client
    body = c.get("/api/resilience?n=1").json()
    assert body["removed"] == [ids["h"]]


# ---------------------------------------------------------------- реальная выгрузка движка

@pytest.fixture(scope="module")
def engine_store(tmp_path_factory):
    out = tmp_path_factory.mktemp("engine")
    subprocess.run([sys.executable, str(ROOT / "run_pipeline.py"), "--output-dir", str(out)],
                   cwd=ROOT, check=True, capture_output=True)
    return GraphStore.load(out / "graph.json")


def test_engine_card_for_largest_external_inflow(engine_store):
    candidates = [n for n in engine_store.nodes.values() if not n["is_seed"]]
    node = max(candidates, key=lambda n: n["out_kzt"] - n["in_kzt"])
    card = node_card(engine_store, node["id"])
    assert "вне выборки" in texts(card["attention"], "text")
    assert all(len(item["text"]) <= 200 for item in card["attention"])


def test_engine_resilience_fragments_network(engine_store):
    result = resilience(engine_store, n=10)
    assert len(result["removed"]) == 10
    assert result["after"]["components"] > result["before"]["components"]
