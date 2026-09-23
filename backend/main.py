"""API для AI-ассистента аналитика.

Запуск: uvicorn backend.main:app --reload --port 8000
"""

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException

from backend.copilot import AskRequest, AskResponse, Copilot, LLMSettings
from backend.store import ROOT, GraphStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = GraphStore.load()
    async with httpx.AsyncClient() as client:
        app.state.copilot = Copilot(app.state.store, client, LLMSettings.from_env())
        yield


app = FastAPI(title="Граф денег — API", lifespan=lifespan)


@app.get("/api/health")
def health():
    store: GraphStore = app.state.store
    return {
        "status": "ok",
        "source": store.source.relative_to(ROOT).as_posix(),
        "nodes": len(store.nodes),
        "links": len(store.links),
    }


@app.post("/api/ask", response_model=AskResponse)
async def ask(request: AskRequest):
    if request.selected_gid is not None and request.selected_gid not in app.state.store.nodes:
        raise HTTPException(status_code=404, detail="Выбранный узел не найден в выгрузке.")
    return await app.state.copilot.ask(request.question, request.selected_gid)
