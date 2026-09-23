# hack-71881218-stndz-main
Hackathon team repository for **STNDZ MAIN**

## Задача
Граф денег: восстановление финансовой структуры организованной группы по транзакционной сети

## Быстрый старт

### 1. Пайплайн (роли, кластеры, CSV, данные для UI)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python pipeline.py --data ./data --out ./out
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Открой URL из терминала (обычно http://localhost:5173).

На выходе пайплайна: `out/nodes_roles.csv`, `out/clusters.csv`, `out/top_nodes.csv`  
и копия для UI: `frontend/public/data/graph.json` (+ CSV).

## Вход

| Файл | Содержание |
|------|------------|
| `data/nodes.parquet` | `gid`, `depth`, `is_seed` |
| `data/edges.parquet` | `src`, `dst`, `sum_kzt`, `n_tx`, `depth` |
| `data/transactions.parquet` | `src`, `dst`, `date`, `sum_kzt` |

## Выход

- `out/nodes_roles.csv` — 2248 узлов: роль, score, кластер, приоритет, evidence
- `out/clusters.csv` — сообщества Louvain + гипотеза
- `out/top_nodes.csv` — топ-30 приоритетов
- `frontend/` — React UI: граф потоков, роли, поиск gid, топ, карточка узла

## UI

- Цвета ролей, направленные рёбра (деньги)
- Топ приоритетов слева, карточка и соседи справа
- Поиск по `gid`, режим «топ-сеть» / «эго 1 hop»
- Кластеры с гипотезами

## Критерии ролей (explainable)

Правила по приоритету (первое совпадение):

| # | Роль | Правило |
|---|------|---------|
| 1 | `consolidator` | `in_deg ≥ 5` и `in_deg ≥ out_deg` |
| 2 | `distributor` | `out_deg ≥ 10` |
| 3 | `consolidator` | иначе `in_deg ≥ 5` |
| 4 | `coordinator` | ≥3 соседей-seed **или** betweenness ≥ 95-й перцентиль и степень ≥ 4 |
| 5 | `transit` | вход и выход, `0.8 ≤ out_kzt/in_kzt ≤ 1.2`, не depth=4 |
| 6 | `terminal` | `out_deg = 0`, depth ≠ 4, и (`in_deg ≥ 2` или `in_kzt ≥ 100000`) |
| 7 | `peripheral` | остальное; обрезки depth=4; слабые листья; orphan |

`evidence` — с числами, до 200 символов. Выводы — гипотезы для проверки.

### Ловушки данных

- depth=4 без исходящих ≠ `terminal`
- у seed `in_kzt` занижен — не опираемся на pass-through вслепую
- 19 orphan seed → `peripheral`

## Приоритет

Вес роли + PageRank/степень/оборот + связи с seed − штраф за truncated.

## Кластеризация

Louvain на неориентированной проекции (`sum_kzt`). Роли считаются на направленном графе.

## Масштабирование до ~1 млн узлов

Approximate betweenness, Leiden/igraph, визуализация только ego/топ-N и супер-узлы кластеров. Степени/обороты — O(E).

## Стек

- Backend/analytics: Python, pandas, networkx, numpy, scipy
- Frontend: Vite + React + react-force-graph-2d

Стартовый код организаторов: `starter/`.

## Схема

```
parquet → метрики → роли → Louvain → CSV
                              └→ frontend/public/data → npm run dev
```
