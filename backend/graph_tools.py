"""Ограниченные запросы к готовой выгрузке, без пересчёта ролей и скоров."""

from collections import deque
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from backend.store import GraphStore

Gid = Annotated[str, StringConstraints(strict=True, pattern=r"^[0-9]{18}$")]
Limit = Annotated[int, Field(strict=True, ge=1, le=30)]
Metric = Literal[
    "priority_score", "role_score", "in_deg", "out_deg",
    "in_kzt", "out_kzt", "pass_through",
]
Role = Literal[
    "consolidator", "coordinator", "distributor", "transit",
    "terminal", "peripheral", "boundary",
]


class Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NodeArgs(Arguments):
    gid: Gid


class NeighborsArgs(NodeArgs):
    direction: Literal["in", "out", "both"] = "both"
    limit: Limit = 10


class CollectorsArgs(Arguments):
    gids: Annotated[list[Gid], Field(min_length=2, max_length=10)]
    limit: Limit = 10


class TopArgs(Arguments):
    metric: Metric = "priority_score"
    n: Limit = 10
    role: Role | None = None


class PathArgs(Arguments):
    src: Gid
    dst: Gid
    max_hops: Annotated[int, Field(strict=True, ge=0, le=8)] = 6


MODELS = {
    "get_node": NodeArgs,
    "neighbors": NeighborsArgs,
    "common_collectors": CollectorsArgs,
    "top_by": TopArgs,
    "path": PathArgs,
}
DESCRIPTIONS = {
    "get_node": "Карточка узла: готовая роль, скоры, суммы, степени и ограничения.",
    "neighbors": "Прямые входящие/исходящие связи, по убыванию суммы. in — плательщики, out — получатели.",
    "common_collectors": "Общие прямые получатели ВСЕХ указанных разных gid, независимо от назначенной роли.",
    "top_by": "Узлы по убыванию разрешённой метрики выгрузки, с необязательным фильтром роли.",
    "path": "Кратчайший по числу рёбер НАПРАВЛЕННЫЙ путь в пределах max_hops; не трассировка одних и тех же денег.",
}


def tool_schemas() -> list[dict]:
    return [
        {"type": "function", "function": {
            "name": name, "description": DESCRIPTIONS[name],
            "parameters": model.model_json_schema(),
        }}
        for name, model in MODELS.items()
    ]


def referenced_gids(value, store: GraphStore) -> set[str]:
    """Ссылки только на реально существующие узлы из результатов функций."""
    if isinstance(value, str):
        return {value} if value in store.nodes else set()
    if isinstance(value, dict):
        value = value.values()
    elif not isinstance(value, (list, tuple)):
        return set()
    result = set()
    for item in value:
        result.update(referenced_gids(item, store))
    return result


class GraphTools:
    def __init__(self, store: GraphStore):
        self.store = store

    def run(self, name: str, arguments: dict) -> dict:
        if name not in MODELS:
            raise ValueError("Неизвестная функция")
        args = MODELS[name].model_validate(arguments).model_dump()
        gids = [args[key] for key in ("gid", "src", "dst") if key in args]
        gids.extend(args.get("gids", []))
        if any(gid not in self.store.nodes for gid in gids):
            return {"error": "unknown_gid", "message": "Узел не найден в выгрузке."}
        return getattr(self, name)(**args)

    def get_node(self, gid: str) -> dict:
        # Копия защищает общий store от случайного изменения потребителем.
        return dict(self.store.nodes[gid])

    def neighbors(self, gid: str, direction: str, limit: int) -> dict:
        links = {}
        if direction in ("in", "both"):
            for edge in self.store.in_links.get(gid, []):
                links[(edge["source"], edge["target"])] = edge
        if direction in ("out", "both"):
            for edge in self.store.out_links.get(gid, []):
                links[(edge["source"], edge["target"])] = edge
        ordered = sorted(links.values(), key=lambda e: (-e["sum_kzt"], e["source"], e["target"]))
        selected = [dict(edge) for edge in ordered[:limit]]
        return {
            "gid": gid, "direction": direction, "total_links": len(ordered),
            "returned": len(selected), "has_more": len(ordered) > limit, "links": selected,
        }

    def common_collectors(self, gids: list[str], limit: int) -> dict:
        gids = list(dict.fromkeys(gids))
        if len(gids) < 2:
            return {"error": "distinct_gids_required", "message": "Нужны разные исходные узлы."}
        per_gid = {
            gid: {edge["target"]: edge for edge in self.store.out_links.get(gid, [])}
            for gid in gids
        }
        common = set.intersection(*(set(edges) for edges in per_gid.values()))
        collectors = []
        for gid in common:
            links = [dict(per_gid[src][gid]) for src in gids]
            collectors.append({
                "gid": gid, "role": self.store.nodes[gid]["role"], "links": links,
                "sum_kzt_from_gids": sum(edge["sum_kzt"] for edge in links),
            })
        collectors.sort(key=lambda row: (-row["sum_kzt_from_gids"], row["gid"]))
        return {
            "gids": gids, "total_collectors": len(collectors),
            "has_more": len(collectors) > limit, "collectors": collectors[:limit],
        }

    def top_by(self, metric: str, n: int, role: str | None) -> dict:
        nodes = [node for node in self.store.nodes.values()
                 if isinstance(node.get(metric), (int, float))
                 and (role is None or node["role"] == role)]
        nodes.sort(key=lambda node: (-node[metric], node["id"]))
        return {
            "metric": metric, "role": role, "total_matches": len(nodes),
            "has_more": len(nodes) > n,
            "nodes": [{"gid": node["id"], "role": node["role"], "value": node[metric]}
                      for node in nodes[:n]],
        }

    def path(self, src: str, dst: str, max_hops: int) -> dict:
        parents = {src: None}
        queue = deque([(src, 0)])
        limited = False
        while queue and dst not in parents:
            current, depth = queue.popleft()
            if depth >= max_hops:
                continue
            for edge in sorted(self.store.out_links.get(current, []), key=lambda e: e["target"]):
                nxt = edge["target"]
                if nxt in parents:
                    continue
                if len(parents) >= 10_000:
                    limited = True
                    break
                parents[nxt] = edge
                queue.append((nxt, depth + 1))
                if nxt == dst:
                    break
            if limited:
                break
        result = {"src": src, "dst": dst, "max_hops": max_hops, "search_limited": limited}
        if dst not in parents:
            return {**result, "status": "not_found_within_limit", "path": [], "links": []}
        links = []
        current = dst
        while current != src:
            edge = parents[current]
            links.append(dict(edge))
            current = edge["source"]
        links.reverse()
        return {
            **result, "status": "found", "hops": len(links),
            "path": [src] + [edge["target"] for edge in links], "links": links,
        }
