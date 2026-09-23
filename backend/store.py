"""Данные для API: читает готовый graph.json, который пишет run_pipeline.py (движок участника 1).

Бэкенд ничего не пересчитывает — только индексирует выгрузку в памяти.
"""

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Порядок поиска: output/ (run_pipeline.py — официальный пайплайн) → out/ (прежний pipeline.py)
# → копия во frontend. MONEYGRAPH_GRAPH_JSON задаёт файл явно.
CANDIDATES = [
    ROOT / "output" / "graph.json",
    ROOT / "out" / "graph.json",
    ROOT / "frontend" / "public" / "data" / "graph.json",
]


def normalize(raw: dict) -> dict:
    """Приводит graph.json к виду {nodes[id, метрики], links[source, target]}.

    Поддерживает два формата:
      * pipeline.py — уже в этом виде, возвращается как есть;
      * движок участника 1 (docs/GRAPH_DATA_CONTRACT.md §5) — nodes[gid, metrics, flags], edges[src, dst].
    """
    if "links" in raw or "edges" not in raw:
        return raw
    nodes = []
    for node in raw["nodes"]:
        flat = {k: v for k, v in node.items() if k not in ("gid", "metrics", "flags")}
        flat.update(node.get("metrics") or {})
        flat["id"] = node["gid"]
        flat["flags"] = list(node.get("flags") or [])
        flat["truncated_by_depth"] = "truncated_by_depth" in flat["flags"]
        nodes.append(flat)
    links = [{"source": e["src"], "target": e["dst"],
              **{k: v for k, v in e.items() if k not in ("src", "dst")}}
             for e in raw["edges"]]
    ranked = sorted((n for n in nodes if n.get("rank") is not None), key=lambda n: n["rank"])
    top = [{"rank": n["rank"], "gid": n["id"], "role": n["role"],
            "priority_score": n["priority_score"], "why": n.get("evidence", "")} for n in ranked]
    return {**raw, "nodes": nodes, "links": links, "top": raw.get("top", top)}


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
        if path is None and os.environ.get("MONEYGRAPH_GRAPH_JSON"):
            path = Path(os.environ["MONEYGRAPH_GRAPH_JSON"])
            if not path.is_file():
                raise FileNotFoundError(f"MONEYGRAPH_GRAPH_JSON указывает на несуществующий файл: {path}")
        if path is None:
            path = next((p for p in CANDIDATES if p.is_file()), None)
            if path is None:
                raise FileNotFoundError("graph.json не найден — запустите python run_pipeline.py")
        raw = normalize(json.loads(path.read_text(encoding="utf-8")))
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
