"""Карточка узла, оценка полноты данных и устойчивость сети.

Всё считается по готовому graph.json: роли и скоры не пересчитываются.
Формулировки — гипотезы для проверки, а не утверждения о виновности.
"""

from backend.store import GraphStore

TOP_COUNTERPARTIES = 3
# тот же порог, что у движка (analytics/config.py: EXTERNAL_FUNDING_THRESHOLD_KZT)
EXTERNAL_MIN_KZT = 1_000_000
EXTERNAL_MIN_RATIO = 2
SEED_CONVERGENCE_MIN = 2

THRESHOLD_GAP = {
    "gap": "Переводы менее 5 000 KZT и межбанковские в выгрузку не входят: дробление сумм не видно",
    "next_request": "При признаках дробления запросить операции ниже порога 5 000 KZT",
}


def kzt(amount: float) -> str:
    if amount >= 1_000_000:
        return f"{amount / 1_000_000:.1f}".replace(".", ",") + " млн KZT"
    if amount >= 1_000:
        return f"{amount / 1_000:.0f} тыс. KZT"
    return f"{amount:.0f} KZT"


def times_phrase(ratio: float) -> str:
    """«в 23 раза», «в 30 раз», «в 2,5 раза» — число согласовано со словом."""
    shown = round(ratio) if ratio >= 10 else round(ratio, 1)
    if shown != int(shown):
        return f"в {shown}".replace(".", ",") + " раза"
    n = int(shown)
    word = "раза" if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else "раз"
    return f"в {n} {word}"


def has_external_source(node: dict) -> bool:
    surplus = node["out_kzt"] - node["in_kzt"]
    return (not node["is_seed"] and surplus >= EXTERNAL_MIN_KZT
            and node["out_kzt"] >= EXTERNAL_MIN_RATIO * node["in_kzt"])


def counterparties(store: GraphStore, links: list[dict], end: str) -> list[dict]:
    ranked = sorted(links, key=lambda link: (-link["sum_kzt"], link[end]))[:TOP_COUNTERPARTIES]
    return [{"gid": link[end], "role": store.nodes[link[end]]["role"],
             "sum_kzt": link["sum_kzt"], "n_tx": link["n_tx"]} for link in ranked]


def attention(node: dict) -> list[dict]:
    notes = []
    if has_external_source(node):
        if node["in_kzt"] > 0:
            ratio = f"{times_phrase(node['out_kzt'] / node['in_kzt'])} больше, чем получил"
        else:
            ratio = "без входящих"
        notes.append({"text": (
            f"Отправил {ratio} от наблюдаемых клиентов ({kzt(node['in_kzt'])} → "
            f"{kzt(node['out_kzt'])}): признаки источника средств вне выборки")})
    seed_payers = node.get("seed_payers") or 0
    if seed_payers >= SEED_CONVERGENCE_MIN:
        notes.append({"text": f"Получает средства напрямую от {seed_payers} seed-клиентов: признаки сбора"})
    return notes


def data_gaps(node: dict) -> list[dict]:
    gaps = []
    if node.get("truncated_by_depth"):
        gaps.append({
            "gap": "Граница выгрузки (колено 4): исходящие переводы не собирались",
            "next_request": "Запросить исходящие переводы клиента за июль 2026: куда ушли полученные средства"})
    if node["is_seed"]:
        gaps.append({
            "gap": "Seed-клиент: входящие переводы из-за пределов выборки не наблюдаются",
            "next_request": "Запросить все входящие переводы клиента, включая межбанковские"})
    elif has_external_source(node):
        gaps.append({
            "gap": (f"Отправлено больше, чем получено от наблюдаемых клиентов: "
                    f"источник {kzt(node['out_kzt'] - node['in_kzt'])} не виден"),
            "next_request": "Запросить входящие переводы клиента, включая межбанковские: источник средств"})
    if node["in_deg"] == 0 and node["out_deg"] == 0:
        gaps.append({
            "gap": "Переводов от 5 000 KZT внутри банка в выгрузке нет",
            "next_request": "Запросить полную выписку клиента, включая переводы менее 5 000 KZT и межбанковские"})
    gaps.append(dict(THRESHOLD_GAP))
    return gaps


def node_card(store: GraphStore, gid: str) -> dict:
    node = store.nodes[gid]
    return {
        "gid": gid,
        "role": node["role"],
        "role_score": node["role_score"],
        "cluster_id": node.get("cluster_id"),
        "priority_score": node.get("priority_score"),
        "evidence": node.get("evidence", ""),
        "is_seed": node["is_seed"],
        "depth": node["depth"],
        "flows": {k: node[k] for k in ("in_deg", "out_deg", "in_kzt", "out_kzt")},
        "top_payers": counterparties(store, store.in_links.get(gid, []), "source"),
        "top_receivers": counterparties(store, store.out_links.get(gid, []), "target"),
        "attention": attention(node),
        "data_gaps": data_gaps(node),
    }


def ranking_metric(store: GraphStore) -> str:
    nodes = store.nodes.values()
    if any((n.get("priority_score") or 0) > 0 for n in nodes):
        return "priority_score"
    if all("betweenness" in n for n in nodes):
        return "betweenness"
    return "degree"


def component_stats(store: GraphStore, kept: set[str]) -> dict:
    parent = {gid: gid for gid in kept}

    def find(gid):
        while parent[gid] != gid:
            parent[gid] = parent[parent[gid]]
            gid = parent[gid]
        return gid

    for link in store.links:
        if link["source"] in kept and link["target"] in kept:
            parent[find(link["source"])] = find(link["target"])
    groups: dict[str, list[str]] = {}
    for gid in kept:
        groups.setdefault(find(gid), []).append(gid)
    # при равных размерах — детерминированный выбор, порядок обхода множества от запуска к запуску разный
    largest = max(groups.values(), key=lambda group: (len(group), min(group))) if groups else []
    return {
        "components": len(groups),
        "largest": len(largest),
        "seeds_in_largest": sum(store.nodes[gid]["is_seed"] for gid in largest),
    }


def resilience(store: GraphStore, n: int) -> dict:
    """Что станет с сетью, если изъять n самых значимых узлов (связность без учёта направления)."""
    metric = ranking_metric(store)

    def score(node):
        if metric == "degree":
            return node["in_deg"] + node["out_deg"]
        return node.get(metric) or 0

    ranked = sorted(store.nodes.values(), key=lambda node: (-score(node), node["id"]))
    removed = [node["id"] for node in ranked[:n]]
    everyone = set(store.nodes)
    return {
        "ranked_by": metric,
        "removed": removed,
        "before": component_stats(store, everyone),
        "after": component_stats(store, everyone - set(removed)),
    }
