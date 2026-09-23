"""Данные для API: читает готовый graph.json, который пишет pipeline.py.

Бэкенд ничего не пересчитывает — только индексирует выгрузку в памяти.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# out/ — основная выгрузка пайплайна; копия во frontend — запасной вариант
CANDIDATES = [ROOT / "out" / "graph.json", ROOT / "frontend" / "public" / "data" / "graph.json"]


@dataclass
class GraphStore:
    source: Path
    meta: dict
    nodes: dict[str, dict]
    links: list[dict]
    top: list[dict]
    clusters: list[dict]
    out_links: dict[str, list[dict]] = field(default_factory=dict)
    in_links: dict[str, list[dict]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | None = None) -> "GraphStore":
        if path is None:
            path = next((p for p in CANDIDATES if p.is_file()), None)
            if path is None:
                raise FileNotFoundError("graph.json не найден — запустите python pipeline.py")
        raw = json.loads(path.read_text(encoding="utf-8"))
        store = cls(
            source=path,
            meta=raw["meta"],
            nodes={n["id"]: n for n in raw["nodes"]},
            links=raw["links"],
            top=raw.get("top", []),
            clusters=raw.get("clusters", []),
        )
        for link in store.links:
            store.out_links.setdefault(link["source"], []).append(link)
            store.in_links.setdefault(link["target"], []).append(link)
        return store
