"""Percentile-based node priority and top-node explanations."""

import numpy as np
import pandas as pd

from analytics import config
from analytics.evidence import quality_flags_for_node


PRIORITY_FEATURE_COLUMNS = (
    "gid",
    "role",
    "role_score",
    "is_seed",
    "in_deg",
    "out_deg",
    "in_kzt",
    "out_kzt",
    "seed_reach2",
    "ext_inflow",
    "pagerank",
    "betweenness",
    "fast_share",
    "sync_in_max",
)
TOP_NODE_WHY_COLUMNS = (
    "evidence",
    "truncated_by_depth",
    "depth",
    "seed_payers",
    "pass_through",
    "retention",
)
ROLE_LABELS_RU = {
    "coordinator": "координатор",
    "distributor": "распределитель",
    "consolidator": "сборщик",
    "transit": "транзитный узел",
    "terminal": "конечный узел",
    "boundary": "граница обхода",
    "peripheral": "прочий узел",
}
QUALITY_FLAG_LABELS_RU = {
    "truncated_by_depth": "обход ограничен глубиной",
    "seed_inflow_incomplete": "входящие стартового узла неполны",
    "outflow_exceeds_inflow": "исходящие выше наблюдаемых входящих",
    "isolated": "нет наблюдаемых связей",
    "external_funding": "возможен внешний приток",
}
QUALITY_FLAG_LABELS_RU_COMPACT = {
    "truncated_by_depth": "обход ограничен",
    "seed_inflow_incomplete": "входящие неполны",
    "outflow_exceeds_inflow": "исходящие выше входящих",
    "isolated": "связей нет",
    "external_funding": "возможен внешний приток",
}


def add_priority_scores(nodes_roles: pd.DataFrame) -> pd.DataFrame:
    """Compute configured percentile-weighted priority for each node."""
    missing_columns = sorted(
        set(PRIORITY_FEATURE_COLUMNS) - set(nodes_roles.columns)
    )
    if missing_columns:
        raise ValueError(
            "Priority feature table is missing columns: "
            f"{', '.join(missing_columns)}"
        )
    if nodes_roles["gid"].isna().any() or nodes_roles["gid"].duplicated().any():
        raise ValueError("Priority feature table must contain unique, non-null gids")
    if nodes_roles.empty:
        raise ValueError("Priority feature table must contain at least one node")
    required_values = set(PRIORITY_FEATURE_COLUMNS) - {"fast_share"}
    if nodes_roles[list(required_values)].isna().any().any():
        raise ValueError("Priority feature table contains missing required values")
    if not nodes_roles["role"].isin(config.ROLE_NAMES).all():
        raise ValueError("Priority feature table contains an unknown role")
    if not nodes_roles["role_score"].between(
        config.ROLE_SCORE_MIN,
        config.ROLE_SCORE_MAX,
    ).all():
        raise ValueError("Priority feature table contains an invalid role score")
    defined_fast_share = nodes_roles["fast_share"].dropna()
    if not defined_fast_share.between(config.ZERO_FLOAT, config.ONE_FLOAT).all():
        raise ValueError("fast_share must stay within the configured [0, 1] range")

    result = nodes_roles.copy()
    flow = result[["in_deg", "out_deg"]].max(axis=config.ONE).rank(
        method="average",
        pct=True,
    )
    structure = (
        result["pagerank"].rank(method="average", pct=True)
        + result["betweenness"].rank(method="average", pct=True)
    ) / (config.ONE + config.ONE)
    volume = np.log1p(result["in_kzt"] + result["out_kzt"]).rank(
        method="average",
        pct=True,
    )
    seed_convergence = (
        result["seed_reach2"] / config.PRIORITY_SEED_REACH_NORMALIZER
    ).clip(upper=config.ONE_FLOAT)
    external = (
        result["ext_inflow"] / config.EXTERNAL_FUNDING_THRESHOLD_KZT
    ).clip(upper=config.ONE_FLOAT)
    temporal = np.maximum(
        result["fast_share"].fillna(config.ZERO_FLOAT),
        (result["sync_in_max"] / config.PRIORITY_SYNC_IN_MAX_NORMALIZER).clip(
            upper=config.ONE_FLOAT
        ),
    )

    result["priority_score"] = sum(
        config.PRIORITY_WEIGHTS[component] * values
        for component, values in (
            ("flow", flow),
            ("structure", structure),
            ("volume", volume),
            ("seed_conv", seed_convergence),
            ("external", external),
            ("temporal", temporal),
        )
    )
    result.loc[result["is_seed"], "priority_score"] *= config.SEED_PRIORITY_MULTIPLIER

    isolated = result["in_deg"].eq(config.ZERO) & result["out_deg"].eq(config.ZERO)
    capped = result["role"].isin(config.PRIORITY_CAPPED_ROLE_NAMES) | isolated
    result.loc[capped, "priority_score"] = result.loc[
        capped,
        "priority_score",
    ].clip(upper=config.LOW_PRIORITY_CAP)

    scores = result["priority_score"].to_numpy(dtype="float64")
    if not np.isfinite(scores).all() or not result["priority_score"].between(
        config.ZERO_FLOAT,
        config.ONE_FLOAT,
    ).all():
        raise ValueError("Priority scores must be finite values within [0, 1]")

    return result.sort_values("gid", kind="mergesort").reset_index(drop=True)


def build_top_nodes(nodes_roles: pd.DataFrame) -> pd.DataFrame:
    """Return the top nodes with stable ranks and concise evidence-backed why."""
    required_columns = set(PRIORITY_FEATURE_COLUMNS) | set(TOP_NODE_WHY_COLUMNS) | {
        "priority_score",
        "in_kzt",
        "out_kzt",
        "ext_inflow",
        "in_deg",
        "out_deg",
    }
    missing_columns = sorted(required_columns - set(nodes_roles.columns))
    if missing_columns:
        raise ValueError(
            "Top-node table is missing columns: " f"{', '.join(missing_columns)}"
        )
    if nodes_roles["gid"].isna().any() or nodes_roles["gid"].duplicated().any():
        raise ValueError("Top-node source must contain unique, non-null gids")

    ranked = nodes_roles.sort_values(
        ["priority_score", "role_score", "gid"],
        ascending=[False, False, True],
        kind="mergesort",
    ).head(config.TOP_NODE_COUNT)
    top_nodes = ranked.loc[
        :,
        [
            "gid",
            "role",
            "priority_score",
            "evidence",
            "is_seed",
            "in_deg",
            "out_deg",
            "in_kzt",
            "out_kzt",
            "ext_inflow",
            "truncated_by_depth",
            "fast_share",
            "sync_in_max",
            "depth",
            "seed_payers",
            "pass_through",
            "retention",
        ],
    ].copy()
    top_nodes.insert(
        config.ZERO,
        "rank",
        range(config.ONE, len(top_nodes) + config.ONE),
    )
    top_nodes["why"] = top_nodes.apply(_build_why, axis=config.ONE)
    return top_nodes.loc[:, config.TOP_NODE_EXPORT_COLUMNS].reset_index(drop=True)


def _build_why(row: pd.Series) -> str:
    score = format(
        float(row["priority_score"]),
        f".{config.PRIORITY_SCORE_DECIMAL_PLACES}f",
    ).replace(".", ",")
    role = row["role"]
    if pd.isna(row["fast_share"]):
        fast_share_text = "быстрые суммы не определены"
    else:
        fast_share_percent = round(
            float(row["fast_share"]) * config.PERCENT_MULTIPLIER,
            config.EVIDENCE_PERCENT_DECIMAL_PLACES,
        )
        fast_share_text = f"быстрые суммы {fast_share_percent:g}%"
    sync_text = f"до {int(row['sync_in_max'])} входящих плательщиков за день"
    role_evidence = _role_summary(row)
    quality_flags = quality_flags_for_node(row)
    quality_text = ", ".join(
        QUALITY_FLAG_LABELS_RU[flag] for flag in quality_flags
    )
    compact_quality_text = ", ".join(
        QUALITY_FLAG_LABELS_RU_COMPACT[flag] for flag in quality_flags
    )
    if not quality_text:
        quality_text = "флаги качества не выявлены"
        compact_quality_text = quality_text

    why = (
        f"Приоритет {score}; {ROLE_LABELS_RU[role]}: {role_evidence}; "
        f"{fast_share_text}; {sync_text}; данные: {quality_text}."
    )
    if len(why) > config.WHY_MAX_CHARACTERS:
        why = (
            f"Приоритет {score}; {ROLE_LABELS_RU[role]}; "
            f"{fast_share_text}; {sync_text}; данные: {compact_quality_text}."
        )
    if len(why) > config.WHY_MAX_CHARACTERS:
        if pd.isna(row["fast_share"]):
            fast_share_short = "быстрые суммы не оценены"
        else:
            fast_share_short = fast_share_text
        why = (
            f"Приоритет {score}; {ROLE_LABELS_RU[role]}; "
            f"{fast_share_short}; входящих за день: {int(row['sync_in_max'])}; "
            f"{compact_quality_text}."
        )
    if len(why) > config.WHY_MAX_CHARACTERS:
        raise ValueError("Top-node why exceeds the configured character limit")
    return why


def _role_summary(row: pd.Series) -> str:
    role = row["role"]
    if role == "coordinator":
        return (
            f"{int(row['in_deg'])} плательщиков→"
            f"{int(row['out_deg'])} получателей"
        )
    if role == "distributor":
        return f"{int(row['out_deg'])} получателей"
    if role == "consolidator":
        return (
            f"{int(row['in_deg'])} плательщиков, стартовых клиентов: "
            f"{int(row['seed_payers'])}"
        )
    if role == "transit":
        pass_through_percent = round(
            float(row["pass_through"]) * config.PERCENT_MULTIPLIER,
            config.EVIDENCE_PERCENT_DECIMAL_PLACES,
        )
        return f"передано дальше {pass_through_percent:g}% входящего потока"
    if role == "terminal":
        retention_percent = round(
            float(row["retention"]) * config.PERCENT_MULTIPLIER,
            config.EVIDENCE_PERCENT_DECIMAL_PLACES,
        )
        return (
            f"удержано {retention_percent:g}% входящего потока; "
            f"колено {int(row['depth'])}"
        )
    if role == "boundary":
        return f"колено {int(row['depth'])}; исходящие не наблюдались"
    if role == "peripheral":
        return (
            f"{int(row['in_deg'])} плательщиков, "
            f"{int(row['out_deg'])} получателей"
        )
    raise ValueError(f"Unsupported graph role: {role}")
