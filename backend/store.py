"""Данные для API: читает готовый graph.json, который пишет pipeline.py.

Бэкенд ничего не пересчитывает — только индексирует выгрузку в памяти.
"""

import json
import re
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
        gids = [node["id"] for node in raw["nodes"]]
        if any(not isinstance(gid, str) or not re.fullmatch(r"[0-9]{18}", gid) for gid in gids):
            raise ValueError("graph.json: id должен быть строкой из 18 цифр")
        if len(set(gids)) != len(gids):
            raise ValueError("graph.json: повторяющиеся id")
        store = cls(
            source=path,
            meta=raw["meta"],
            nodes={n["id"]: n for n in raw["nodes"]},
            links=raw["links"],
            top=raw.get("top", []),
            clusters=raw.get("clusters", []),
        )
        pairs = set()
        for link in store.links:
            if link["source"] not in store.nodes or link["target"] not in store.nodes:
                raise ValueError("graph.json: связь с неизвестным или нестроковым id")
            pair = (link["source"], link["target"])
            if pair in pairs:
                raise ValueError("graph.json: связи должны быть агрегированы по source/target")
            pairs.add(pair)
            store.out_links.setdefault(link["source"], []).append(link)
            store.in_links.setdefault(link["target"], []).append(link)
        return store
