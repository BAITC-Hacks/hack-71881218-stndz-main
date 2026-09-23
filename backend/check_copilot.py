"""Реальная проверка LLM: python -m backend.check_copilot [--all].

Запускается отдельно от pytest. mode=rules считается неуспехом, даже если
фолбэк вернул правдоподобный ответ. gid выбираются из выгрузки, а не из кода.
"""

import argparse
import asyncio
import time
from dataclasses import dataclass

import httpx

from backend.copilot import Copilot, CopilotResult
from backend.graph_tools import MODELS
from backend.settings import LLMSettings
from backend.store import GraphStore


@dataclass(frozen=True)
class Check:
    name: str
    question: str
    tool: str
    arguments: dict
    selected_gid: str | None = None


def checks(store: GraphStore) -> list[Check]:
    result = [Check("top", "Покажи 3 узла с наибольшим priority_score.", "top_by",
                    {"metric": "priority_score", "n": 3})]
    if not store.nodes:
        return result
    gid = max(store.nodes, key=lambda key: store.nodes[key]["priority_score"])
    result.extend([
        Check("node", "Объясни роль выбранного клиента.", "get_node", {"gid": gid}, gid),
        Check("neighbors", "Кому выбранный клиент переводит деньги?", "neighbors",
              {"gid": gid, "direction": "out"}, gid),
    ])
    incoming = next((edges for edges in store.in_links.values() if len(edges) >= 2), None)
    if incoming:
        gids = [edge["source"] for edge in incoming[:2]]
        result.append(Check("common", f"Найди общих прямых получателей этих клиентов: {gids[0]} и {gids[1]}.",
                            "common_collectors", {"gids": gids}))
    if store.links:
        edge = store.links[0]
        result.append(Check("path", f"Найди направленный путь от {edge['source']} до {edge['target']}.",
                            "path", {"src": edge["source"], "dst": edge["target"]}))
    return result


def matches(check: Check, result: CopilotResult, store: GraphStore) -> bool:
    if result.mode != "llm" or not result.tool_results:
        return False
    if any(gid not in store.nodes or gid not in result.answer for gid in result.gids):
        return False
    for record in result.tool_results:
        if record.name != check.tool or "error" in record.result:
            continue
        arguments = MODELS[record.name].model_validate(record.arguments).model_dump()
        if all((set(arguments.get(key, [])) == set(value) if key == "gids"
                else arguments.get(key) == value) for key, value in check.arguments.items()):
            return True
    return False


async def run_checks(copilot: Copilot, selected: list[Check]) -> bool:
    success = True
    for check in selected:
        start = time.monotonic()
        result = await copilot.ask(check.question, check.selected_gid)
        ok = matches(check, result, copilot.store)
        names = ",".join(record.name for record in result.tool_results) or "none"
        print(f"{'PASS' if ok else 'FAIL'} {check.name}: mode={result.mode}, "
              f"seconds={time.monotonic() - start:.2f}, tools={names}", flush=True)
        if not ok:
            print(result.warning or "Ожидаемые функция и аргументы не получены.", flush=True)
        success = success and ok
    return success


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--all", action="store_true", help="проверить все пять типов вопросов")
    group.add_argument("--case", choices=["top", "node", "neighbors", "common", "path"], default="top")
    args = parser.parse_args()
    try:
        settings = LLMSettings.from_env()
        if not settings.model or (settings.provider != "ollama" and not settings.api_key):
            print("LLM не настроена. Заполните backend/.env по примеру backend/.env.example.")
            return 2
        store = GraphStore.load()
    except (ValueError, FileNotFoundError) as exc:
        print(str(exc))
        return 2
    selected = [check for check in checks(store) if args.all or check.name == args.case]
    if not selected:
        print("В выгрузке нет данных для выбранной проверки.")
        return 2

    async def run():
        async with httpx.AsyncClient() as client:
            return await run_checks(Copilot(store, client, settings), selected)

    return 0 if asyncio.run(run()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
