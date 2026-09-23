"""The UI reads one snapshot, with paginated history and matching CSV downloads."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.store import GraphStore


@pytest.fixture
def snapshot(tmp_path):
    a, b, isolated = [str(10**17 + i) for i in range(3)]
    transactions = [
        {"src": a, "dst": b, "date": "2026-07-01", "sum_kzt": 5000.0},
        {"src": b, "dst": a, "date": "2026-07-03", "sum_kzt": 9000.0},
        {"src": a, "dst": a, "date": "2026-07-02", "sum_kzt": 7000.0},
        {"src": a, "dst": b, "date": "2026-07-01", "sum_kzt": 5000.0},
    ]
    payload = {
        "meta": {"nodes": 3, "edges": 3, "tx": 4,
                 "date_from": "2026-07-01", "date_to": "2026-07-03"},
        "nodes": [
            {"gid": gid, "role": "peripheral", "priority_score": 0.3,
             "role_score": 0.5, "cluster_id": 0, "evidence": "1 synthetic node",
             "rank": index + 1, "is_seed": False, "depth": 1,
             "metrics": {"in_kzt": 9000.0 if gid == a else 0.0}, "flags": []}
            for index, gid in enumerate((a, b, isolated))
        ],
        "edges": [
            {"src": a, "dst": b, "sum_kzt": 10000.0, "n_tx": 2},
            {"src": b, "dst": a, "sum_kzt": 9000.0, "n_tx": 1},
            {"src": a, "dst": a, "sum_kzt": 7000.0, "n_tx": 1},
        ],
        "clusters": [{"cluster_id": 0, "n_nodes": 3}],
        "transactions": transactions,
    }
    path = tmp_path / "graph.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path, payload, (a, b, isolated)


@pytest.fixture
def client(snapshot, monkeypatch):
    path, _, ids = snapshot
    monkeypatch.setenv("MONEYGRAPH_GRAPH_JSON", str(path))
    with TestClient(app) as api:
        yield api, ids


def test_graph_is_normalized_and_omits_full_history(client, snapshot):
    api, (a, _, _) = client
    response = api.get("/api/graph")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"meta", "nodes", "links", "top", "clusters"}
    assert body["meta"]["transactions_available"] is True
    assert body["meta"]["date_from"] == "2026-07-01"
    assert body["nodes"][0]["id"] == a
    assert body["nodes"][0]["in_kzt"] == 9000.0
    assert "metrics" not in body["nodes"][0]
    assert body["links"][0]["source"] == a
    assert body["top"][0]["why"] == "1 synthetic node"
    # Replacing the on-disk graph must not mix a new graph with old transaction indexes.
    snapshot[0].write_text("{}", encoding="utf-8")
    assert api.get("/api/graph").json() == body
    assert api.get(f"/api/nodes/{a}/transactions").json()["total"] == 4


def test_transactions_sort_paginate_and_keep_duplicate_transfers(client):
    api, (a, b, _) = client
    body = api.get(f"/api/nodes/{a}/transactions?limit=2&offset=1").json()
    assert body == {
        "gid": a, "available": True, "total": 4, "limit": 2, "offset": 1,
        "transactions": [
            {"src": a, "dst": a, "date": "2026-07-02", "sum_kzt": 7000.0},
            {"src": a, "dst": b, "date": "2026-07-01", "sum_kzt": 5000.0},
        ],
    }
    full = api.get(f"/api/nodes/{a}/transactions").json()
    assert full["transactions"][0]["src"] == b
    assert full["transactions"][2] == full["transactions"][3]
    assert api.get(f"/api/nodes/{a}/transactions?offset=99").json()["transactions"] == []


@pytest.mark.parametrize("direction,total", [("all", 4), ("in", 2), ("out", 3)])
def test_transaction_directions_count_self_transfer_once(client, direction, total):
    api, (a, _, _) = client
    body = api.get(f"/api/nodes/{a}/transactions?direction={direction}").json()
    assert body["total"] == len(body["transactions"]) == total
    endpoint = {"in": "dst", "out": "src"}.get(direction)
    if endpoint:
        assert all(row[endpoint] == a for row in body["transactions"])


@pytest.mark.parametrize("query", ["direction=both", "limit=0", "limit=1001", "offset=-1"])
def test_transaction_query_validation(client, query):
    api, (a, _, _) = client
    assert api.get(f"/api/nodes/{a}/transactions?{query}").status_code == 422


def test_transactions_unknown_and_isolated_nodes(client):
    api, (_, _, isolated) = client
    assert api.get("/api/nodes/999999999999999999/transactions").status_code == 404
    body = api.get(f"/api/nodes/{isolated}/transactions").json()
    assert body["available"] is True and body["total"] == 0 and body["transactions"] == []


@pytest.mark.parametrize("present", [False, True])
def test_missing_history_is_distinct_from_empty_history(snapshot, monkeypatch, present):
    path, payload, (a, _, _) = snapshot
    if present:
        payload["transactions"] = []
    else:
        payload.pop("transactions")
    path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("MONEYGRAPH_GRAPH_JSON", str(path))
    with TestClient(app) as api:
        assert api.get("/api/graph").json()["meta"]["transactions_available"] is present
        body = api.get(f"/api/nodes/{a}/transactions").json()
    assert body["available"] is present and body["transactions"] == []


@pytest.mark.parametrize("filename", ["nodes_roles.csv", "clusters.csv", "top_nodes.csv"])
def test_exports_come_from_loaded_graph_directory(client, snapshot, filename):
    api, _ = client
    assert api.get(f"/api/exports/{filename}").status_code == 404
    expected = b"gid,evidence\n100000000000000000,snapshot\n"
    (snapshot[0].parent / filename).write_bytes(expected)
    response = api.get(f"/api/exports/{filename}")
    assert response.status_code == 200 and response.content == expected
    assert response.headers["content-type"].startswith("text/csv")
    assert filename in response.headers["content-disposition"]


@pytest.mark.parametrize("filename", ["graph.json", "secret.csv", "..%2Fsecret.csv"])
def test_exports_reject_unlisted_paths(client, filename):
    api, _ = client
    assert api.get(f"/api/exports/{filename}").status_code == 404


def test_exports_reject_symlinks_outside_snapshot_directory(client, snapshot, tmp_path):
    api, _ = client
    outside = tmp_path / "other" / "unrelated.csv"
    outside.parent.mkdir()
    outside.write_text("not a snapshot export", encoding="utf-8")
    (snapshot[0].parent / "top_nodes.csv").symlink_to(outside)
    assert api.get("/api/exports/top_nodes.csv").status_code == 404


@pytest.mark.parametrize("relative", [False, True])
def test_health_accepts_external_and_relative_snapshot_paths(snapshot, monkeypatch, relative):
    path, _, _ = snapshot
    monkeypatch.chdir(path.parent)
    monkeypatch.setenv("MONEYGRAPH_GRAPH_JSON", path.name if relative else str(path))
    with TestClient(app) as api:
        response = api.get("/api/health")
    assert response.status_code == 200
    assert response.json()["source"] == path.as_posix()


@pytest.mark.parametrize("field,value", [
    ("src", 10**17), ("dst", "999999999999999999"),
    ("date", "2026-02-30"), ("sum_kzt", float("nan")),
])
def test_store_rejects_history_that_cannot_be_shown_consistently(snapshot, field, value):
    path, payload, _ = snapshot
    payload["transactions"][0][field] = value
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError):
        GraphStore.load(path)
