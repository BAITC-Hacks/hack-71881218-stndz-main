"""API для AI-ассистента аналитика.

Запуск: uvicorn backend.main:app --reload --port 8000
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.store import ROOT, GraphStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = GraphStore.load()
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
