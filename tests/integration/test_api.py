"""Контракт Copilot: направление, происхождение фактов, офлайн и сбои LLM."""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.copilot import Copilot, LLMSettings
from backend.graph_tools import GraphTools
from backend.main import app
from backend.store import GraphStore


def test_health():
    with TestClient(app) as client:
        r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["nodes"] == 2248
    assert body["links"] == 3119


@pytest.fixture
def graph(tmp_path):
    # Синтетические идентификаторы, не зависящие от узлов хакатонного набора.
    ids = {label: str(10**17 + index) for index, label in enumerate("abcdef")}
    edges = [
        ("a", "c", 5000), ("b", "c", 7000), ("a", "d", 8000),
        ("d", "e", 9000), ("c", "a", 6000),
    ]
    links = [{"source": ids[src], "target": ids[dst], "sum_kzt": amount, "n_tx": 1}
             for src, dst, amount in edges]
    nodes = []
    for label, gid in ids.items():
        incoming = [edge for edge in links if edge["target"] == gid]
        outgoing = [edge for edge in links if edge["source"] == gid]
        nodes.append({
            "id": gid, "role": "consolidator" if label == "c" else "peripheral",
            "role_score": 0.5, "priority_score": 0.9 if label in "cd" else 0.1,
            "in_deg": len(incoming), "out_deg": len(outgoing),
            "in_kzt": sum(edge["sum_kzt"] for edge in incoming),
            "out_kzt": sum(edge["sum_kzt"] for edge in outgoing),
            "pass_through": 0.5 if label == "c" else None,
            "is_seed": label == "b", "depth": 4 if label == "e" else 1,
            "truncated_by_depth": label == "e", "evidence": "синтетическая выгрузка",
        })
    path = tmp_path / "graph.json"
    path.write_text(json.dumps({"meta": {}, "nodes": nodes, "links": links}), encoding="utf-8")
    return GraphStore.load(path), ids


def test_node_preserves_string_identity_and_exported_metrics(graph):
    store, ids = graph
    result = GraphTools(store).run("get_node", {"gid": ids["c"]})
    assert result["id"] == ids["c"]
    assert result["in_kzt"] == 12000
    assert result["out_kzt"] == 6000
    result["role"] = "changed"
    assert store.nodes[ids["c"]]["role"] == "consolidator"


def test_neighbors_direction_and_partial_results(graph):
    store, ids = graph
    tools = GraphTools(store)
    incoming = tools.run("neighbors", {"gid": ids["a"], "direction": "in"})
    assert [(e["source"], e["target"]) for e in incoming["links"]] == [(ids["c"], ids["a"])]
    outgoing = tools.run("neighbors", {"gid": ids["a"], "direction": "out", "limit": 1})
    assert outgoing["links"][0]["target"] == ids["d"]
    assert outgoing["total_links"] == 2 and outgoing["returned"] == 1 and outgoing["has_more"]
    both = tools.run("neighbors", {"gid": ids["a"]})
    assert both["total_links"] == 3
    empty = tools.run("neighbors", {"gid": ids["f"]})
    assert empty["links"] == [] and not empty["has_more"]


def test_common_collectors_requires_every_payer(graph):
    store, ids = graph
    tools = GraphTools(store)
    result = tools.run("common_collectors", {"gids": [ids["a"], ids["b"]]})
    assert result["total_collectors"] == 1
    row = result["collectors"][0]
    assert row["gid"] == ids["c"] and row["sum_kzt_from_gids"] == 12000
    assert {edge["source"] for edge in row["links"]} == {ids["a"], ids["b"]}
    assert tools.run("common_collectors", {"gids": [ids["a"], ids["c"]]})["collectors"] == []
    assert tools.run("common_collectors", {"gids": [ids["a"], ids["a"]]})["error"] == "distinct_gids_required"


def test_top_filter_ties_and_null_metric(graph):
    store, ids = graph
    tools = GraphTools(store)
    top = tools.run("top_by", {"n": 2})
    assert [node["gid"] for node in top["nodes"]] == [ids["c"], ids["d"]]
    assert top["has_more"]
    filtered = tools.run("top_by", {"role": "consolidator", "metric": "in_kzt"})
    assert filtered["nodes"] == [{"gid": ids["c"], "role": "consolidator", "value": 12000}]
    assert tools.run("top_by", {"metric": "pass_through"})["total_matches"] == 1


def test_path_is_directed_bounded_and_cycle_safe(graph):
    store, ids = graph
    tools = GraphTools(store)
    path = tools.run("path", {"src": ids["a"], "dst": ids["e"]})
    assert path["path"] == [ids["a"], ids["d"], ids["e"]]
    assert path["hops"] == 2
    assert [edge["sum_kzt"] for edge in path["links"]] == [8000, 9000]
    assert tools.run("path", {"src": ids["a"], "dst": ids["e"], "max_hops": 1})["status"] == "not_found_within_limit"
    assert tools.run("path", {"src": ids["e"], "dst": ids["a"]})["status"] == "not_found_within_limit"
    same = tools.run("path", {"src": ids["a"], "dst": ids["a"]})
    assert same["hops"] == 0 and same["path"] == [ids["a"]] and same["links"] == []


@pytest.mark.parametrize("name,arguments", [
    ("get_node", {"gid": 10**17}),
    ("get_node", {"gid": str(10**18)}),
    ("top_by", {"metric": "pagerank"}),  # Не экспортируется в nodes JSON.
    ("top_by", {"n": 31}),
    ("top_by", {"n": True}),
    ("top_by", {"n": "2"}),
    ("top_by", {"unexpected": "argument"}),
    ("common_collectors", {"gids": []}),
])
def test_invalid_tool_arguments_rejected(graph, name, arguments):
    store, _ = graph
    with pytest.raises(ValidationError):
        GraphTools(store).run(name, arguments)


@pytest.mark.parametrize("corruption", ["numeric_id", "duplicate_id", "unknown_endpoint", "duplicate_edge"])
def test_store_rejects_ambiguous_graph_identity(graph, corruption):
    store, _ = graph
    raw = json.loads(store.source.read_text(encoding="utf-8"))
    if corruption == "numeric_id":
        raw["nodes"][0]["id"] = int(raw["nodes"][0]["id"])
    elif corruption == "duplicate_id":
        raw["nodes"].append(raw["nodes"][0])
    elif corruption == "unknown_endpoint":
        raw["links"][0]["source"] = str(10**17 + 99)
    else:
        raw["links"].append(raw["links"][0])
    store.source.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError):
        GraphStore.load(store.source)


@pytest.fixture
def api(graph, monkeypatch):
    store, ids = graph
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setattr(GraphStore, "load", classmethod(lambda cls, path=None: store))
    with TestClient(app) as client:
        yield client, ids


@pytest.mark.parametrize("template,expected", [
    ("Карточка {c}", "Входящие: 12000 KZT"),
    ("Входящие соседи {c}", "направление in"),
    ("Кому отправляет {a}", "направление out"),
    ("Кто собирает деньги с {a} и {b}?", "Общие прямые получатели"),
    ("Топ 2 по in_kzt", "По убыванию in_kzt"),
    ("Путь {a} {e}", "Направленный путь (2 рёбер)"),
])
def test_ask_without_key_uses_tools(api, template, expected):
    client, ids = api
    response = client.post("/api/ask", json={"question": template.format(**ids)})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"answer", "gids", "mode"}
    assert body["mode"] == "rules"
    assert expected in body["answer"]
    assert body["gids"] and set(body["gids"]) <= set(ids.values())
    assert all(isinstance(gid, str) and gid in body["answer"] for gid in body["gids"])
    assert "гипотез" in body["answer"].lower()


def test_unknown_gid_and_unsupported_question(api):
    client, _ = api
    body = client.post("/api/ask", json={"question": f"Карточка {10**17 + 99}"}).json()
    assert body["gids"] == []
    assert "не найден" in body["answer"]
    body = client.post("/api/ask", json={"question": "Расскажи про погоду"}).json()
    assert body["gids"] == []
    assert "Поддерживаются" in body["answer"]
    unavailable = client.post("/api/ask", json={"question": "Топ 3 по pagerank"}).json()
    assert unavailable["gids"] == [] and "Поддерживаются" in unavailable["answer"]


def test_node_answer_discloses_data_limits(api):
    client, ids = api
    boundary = client.post("/api/ask", json={"question": f"Карточка {ids['e']}"}).json()
    seed = client.post("/api/ask", json={"question": f"Карточка {ids['b']}"}).json()
    assert "исходящие не собирались" in boundary["answer"]
    assert "входящие неполны" in seed["answer"]


@pytest.mark.parametrize("payload", [
    {}, {"question": "  "}, {"question": "x" * 2001}, {"question": 42},
    {"question": "топ", "api_key": "client-secret"},
])
def test_ask_rejects_invalid_requests(api, payload):
    client, _ = api
    assert client.post("/api/ask", json=payload).status_code == 422


def completion(*calls, content=None):
    return {"choices": [{"message": {"role": "assistant", "content": content, "tool_calls": list(calls)}}]}


def tool_call(name, arguments, call_id="call_a"):
    return {"id": call_id, "type": "function", "function": {
        "name": name, "arguments": json.dumps(arguments),
    }}


def ask_mocked(store, question, handler, settings=None, selected_gid=None):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            copilot = Copilot(store, client, settings or LLMSettings(
                base_url="https://provider.example/v1", api_key="test-secret", model="test-model",
            ))
            return await copilot.ask(question, selected_gid)
    return asyncio.run(run())


def test_llm_tool_chain_grounds_answer_and_ignores_final_fabrication(graph):
    store, ids = graph
    requests = []

    def handler(request):
        assert str(request.url) == "https://provider.example/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-secret"
        body = json.loads(request.content)
        requests.append(body)
        assert body["model"] == "test-model"
        assert len(body["tools"]) == 5
        if len(requests) == 1:
            return httpx.Response(200, json=completion(tool_call("top_by", {"n": 1})))
        if len(requests) == 2:
            result = json.loads(body["messages"][-1]["content"])
            assert result["nodes"][0]["gid"] == ids["c"]
            return httpx.Response(200, json=completion(tool_call("get_node", {"gid": ids["c"]})))
        return httpx.Response(200, json=completion(content="Обвинение и выдуманная сумма 987654321"))

    response = ask_mocked(store, "Кого проверить первым? Покажи карточку лидера.", handler)
    assert response.mode == "llm" and len(requests) == 3
    assert [row.name for row in response.tool_results] == ["top_by", "get_node"]
    assert response.gids == [ids["c"]]
    assert "12000" in response.answer and "6000" in response.answer
    assert "987654321" not in response.answer and "Обвинение" not in response.answer


@pytest.mark.parametrize("failure", ["timeout", "http_error", "invalid_json", "invalid_message", "no_tools", "unknown_tool", "numeric_gid", "invented_gid", "invented_known_gid", "extra_argument", "unbounded_loop"])
def test_llm_failure_falls_back_without_leaking_provider_content(graph, failure):
    store, ids = graph
    count = 0

    def handler(request):
        nonlocal count
        count += 1
        if failure == "timeout":
            raise httpx.ReadTimeout("test-secret", request=request)
        if failure == "http_error":
            return httpx.Response(503, text="test-secret")
        if failure == "invalid_json":
            return httpx.Response(200, text="test-secret")
        if failure == "invalid_message":
            return httpx.Response(200, json={"choices": [{"message": []}]})
        if failure == "no_tools":
            return httpx.Response(200, json=completion(content="test-secret"))
        name = "delete_graph" if failure == "unknown_tool" else "get_node"
        arguments = {"gid": ids["a"]}
        if failure == "numeric_gid":
            arguments["gid"] = int(ids["a"])
        elif failure == "invented_gid":
            arguments["gid"] = str(10**17 + 99)
        elif failure == "invented_known_gid":
            arguments["gid"] = ids["f"]  # Существует, но не получен из вопроса или функций.
        elif failure == "extra_argument":
            arguments["invented_sum"] = 123
        return httpx.Response(200, json=completion(tool_call(name, arguments)))

    response = ask_mocked(store, f"Карточка {ids['a']}", handler)
    assert response.mode == "rules" and response.warning
    assert response.tool_results[0].name == "get_node"
    assert response.gids == [ids["a"]]
    assert "test-secret" not in response.model_dump_json()
    assert count <= 3


@pytest.mark.parametrize("settings,mode", [
    (LLMSettings(api_key=""), "rules"),
    (LLMSettings(api_key="test-secret", model=""), "rules"),
])
def test_missing_configuration_does_not_contact_provider(graph, settings, mode):
    store, _ = graph

    def handler(request):
        pytest.fail("Неожиданный сетевой запрос")

    assert ask_mocked(store, "Топ 2", handler, settings).mode == mode


@pytest.mark.parametrize("question,expected", [
    ("Покажи карточку выбранного узла", "Узел {c}"),
    ("Кто платит этому клиенту?", "направление in"),
    ("Кому он отправляет?", "направление out"),
])
def test_selected_node_context(api, question, expected):
    client, ids = api
    response = client.post("/api/ask", json={"question": question, "selected_gid": ids["c"]})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"answer", "gids", "mode"}
    assert body["mode"] == "rules"
    assert expected.format(**ids) in body["answer"]
    assert ids["c"] in body["gids"]


def test_explicit_gid_wins_over_selection(api):
    client, ids = api
    body = client.post("/api/ask", json={
        "question": f"Карточка {ids['a']}", "selected_gid": ids["f"],
    }).json()
    assert body["gids"] == [ids["a"]]


def test_selection_does_not_change_global_or_unsupported_question(api):
    client, ids = api
    for question in ("Топ 2", "Расскажи про погоду", "Кто собирает деньги с этих пятерых?"):
        plain = client.post("/api/ask", json={"question": question, "selected_gid": None}).json()
        selected = client.post("/api/ask", json={"question": question, "selected_gid": ids["f"]}).json()
        assert selected == plain


@pytest.mark.parametrize("selected_gid,status", [
    (10**17, 422), ("invalid", 422), (str(10**18), 422), (str(10**17 + 99), 404),
])
def test_invalid_or_unknown_selection(api, selected_gid, status):
    client, _ = api
    response = client.post("/api/ask", json={"question": "Карточка", "selected_gid": selected_gid})
    assert response.status_code == status


def test_llm_receives_selected_context_and_fallback_retains_it(graph):
    store, ids = graph
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        context = json.loads(body["messages"][1]["content"])
        assert context == {"question": "Покажи карточку", "selected_gid": ids["c"]}
        if len(calls) == 1:
            return httpx.Response(200, json=completion(tool_call("get_node", {"gid": ids["c"]})))
        return httpx.Response(200, json=completion())

    result = ask_mocked(store, "Покажи карточку", handler, selected_gid=ids["c"])
    assert result.mode == "llm" and result.gids == [ids["c"]]
    result = ask_mocked(store, "Покажи карточку", lambda r: httpx.Response(503), selected_gid=ids["c"])
    assert result.mode == "rules" and result.gids == [ids["c"]]
    assert "использован разбор по правилам" in result.answer


def test_api_fallback_keeps_agreed_response_shape(api):
    client, ids = api
    app.state.copilot.settings = LLMSettings(api_key="test-secret", model="")
    body = client.post("/api/ask", json={"question": "Карточка", "selected_gid": ids["c"]}).json()
    assert set(body) == {"answer", "gids", "mode"}
    assert body["mode"] == "rules" and body["gids"] == [ids["c"]]
    assert "LLM_MODEL не задан" in body["answer"]
