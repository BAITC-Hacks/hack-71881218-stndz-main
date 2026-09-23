"""API для AI-ассистента аналитика.

Запуск: uvicorn backend.main:app --reload --port 8000
"""

from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse

from backend.copilot import AskRequest, AskResponse, Copilot, LLMSettings
from backend.insights import node_card, resilience
from backend.store import ROOT, GraphStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = GraphStore.load()
    async with httpx.AsyncClient() as client:
        app.state.copilot = Copilot(app.state.store, client, LLMSettings.from_env())
        yield


app = FastAPI(title="Граф денег — API", lifespan=lifespan)
EXPORT_FILENAMES = {"nodes_roles.csv", "clusters.csv", "top_nodes.csv"}


@app.get("/api/health")
def health():
    store: GraphStore = app.state.store
    return {
        "status": "ok",
        "source": (store.source.relative_to(ROOT).as_posix()
                   if store.source.is_relative_to(ROOT) else store.source.as_posix()),
        "nodes": len(store.nodes),
        "links": len(store.links),
    }


@app.get("/api/graph")
def graph():
    store: GraphStore = app.state.store
    return {
        "meta": {**store.meta, "transactions_available": store.transactions is not None},
        "nodes": list(store.nodes.values()),
        "links": store.links,
        "top": store.top,
        "clusters": store.clusters,
    }


@app.get("/api/nodes/{gid}/transactions")
def transactions(
    gid: str,
    direction: Literal["all", "in", "out"] = "all",
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    store: GraphStore = app.state.store
    if gid not in store.nodes:
        raise HTTPException(status_code=404, detail="Узел не найден в выгрузке.")
    rows = store.node_transactions.get(gid, [])
    if direction != "all":
        endpoint = "dst" if direction == "in" else "src"
        rows = [row for row in rows if row[endpoint] == gid]
    return {
        "gid": gid,
        "available": store.transactions is not None,
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "transactions": [
            {key: row[key] for key in ("src", "dst", "date", "sum_kzt")}
            for row in rows[offset:offset + limit]
        ],
    }


@app.get("/api/exports/{filename}")
def export_file(filename: str):
    if filename not in EXPORT_FILENAMES:
        raise HTTPException(status_code=404, detail="Выгрузка не найдена.")
    directory = app.state.store.source.parent
    path = (directory / filename).resolve()
    if path.parent != directory or not path.is_file():
        raise HTTPException(status_code=404, detail="Выгрузка не найдена.")
    return FileResponse(path, media_type="text/csv", filename=filename)


@app.post("/api/ask", response_model=AskResponse)
async def ask(request: AskRequest):
    if request.selected_gid is not None and request.selected_gid not in app.state.store.nodes:
        raise HTTPException(status_code=404, detail="Выбранный узел не найден в выгрузке.")
    return await app.state.copilot.ask(request.question, request.selected_gid)


@app.get("/api/nodes/{gid}/card")
def card(gid: str):
    try:
        return node_card(app.state.store, gid)
    except KeyError:
        raise HTTPException(status_code=404, detail="Узел не найден в выгрузке.") from None


@app.get("/api/resilience")
def network_resilience(n: int = Query(10, ge=1, le=100)):
    return resilience(app.state.store, n)
