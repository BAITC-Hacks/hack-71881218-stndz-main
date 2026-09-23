from fastapi.testclient import TestClient

from backend.main import app


def test_health():
    with TestClient(app) as client:
        r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["nodes"] == 2248
    assert body["links"] == 3119
