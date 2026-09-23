"""Russian, number-backed explanations for assigned structural roles."""

import pandas as pd

from analytics import config


EVIDENCE_COLUMNS = (
    "role",
    "depth",
    "is_seed",
    "in_deg",
    "out_deg",
    "in_kzt",
    "out_kzt",
    "pass_through",
    "retention",
    "seed_payers",
    "seed_reach2",
    "truncated_by_depth",
)


def add_role_evidence(nodes_roles: pd.DataFrame) -> pd.DataFrame:
    """Add concise role explanations and preserve observability caveats."""
    missing_columns = sorted(set(EVIDENCE_COLUMNS) - set(nodes_roles.columns))
    if missing_columns:
        raise ValueError(f"Evidence features are missing columns: {', '.join(missing_columns)}")

    result = nodes_roles.copy()
    evidence = []
    for record in result.to_dict(orient="records"):
        text = _explain_role(record)
        if record["is_seed"]:
            text = f"{text} Входящие извне выборки не наблюдаются."
        if record["truncated_by_depth"] and record["role"] != "boundary":
            text = (
                f"{text} Граница обхода: исходящие не наблюдались."
            )
        if len(text) > config.EVIDENCE_MAX_CHARACTERS:
            raise ValueError(
                "Role evidence exceeds the configured character limit for "
                f"role {record['role']}"
            )
        if not text or not any(character.isdigit() for character in text):
            raise ValueError("Role evidence must be non-empty and contain at least one number")
        evidence.append(text)

    result["evidence"] = evidence
    return result


def _explain_role(record: dict) -> str:
    role = record["role"]
    in_degree = int(record["in_deg"])
    out_degree = int(record["out_deg"])
    in_amount = _format_amount(record["in_kzt"])
    out_amount = _format_amount(record["out_kzt"])
    depth = int(record["depth"])

    if role == "coordinator":
        turnover_amount = _format_amount(
            float(record["in_kzt"]) + float(record["out_kzt"])
        )
        return (
            f"Признаки координации: {in_degree} плательщиков → {out_degree} получателей; "
            f"оборот {turnover_amount} KZT; "
            f"достижимы seed-клиенты: {int(record['seed_reach2'])} "
            f"в пределах {config.SEED_REACH_DISTANCE} шагов."
        )
    if role == "distributor":
        return (
            f"Признаки распределения: {out_degree} получателей; "
            f"исходящий поток {out_amount} KZT."
        )
    if role == "consolidator":
        return (
            f"Признаки сбора: {in_degree} плательщиков, из них seed: "
            f"{int(record['seed_payers'])}; входящий поток {in_amount} KZT."
        )
    if role == "transit":
        ratio = _format_percent(float(record["pass_through"]))
        return (
            f"Признаки транзита: получено {in_amount}, отправлено {out_amount} KZT; "
            f"передано дальше {ratio}% входящего потока."
        )
    if role == "terminal":
        retention = _format_percent(float(record["retention"]))
        return (
            f"Признаки удержания: осталось {retention}% входящего потока "
            f"({in_amount} KZT от {in_degree} плательщиков); колено {depth}."
        )
    if role == "boundary":
        return (
            f"Граница выгрузки: колено {depth}; исходящие здесь не собирались, "
            "вывод об удержании невозможен."
        )
    if role == "peripheral":
        return (
            f"Явное правило роли не сработало: {in_degree} плательщиков и "
            f"{out_degree} получателей; входящий поток {in_amount} KZT."
        )
    raise ValueError(f"Unsupported graph role: {role}")


def _format_amount(amount: float) -> str:
    if amount >= config.EVIDENCE_MILLION_KZT:
        value = round(
            amount / config.EVIDENCE_MILLION_KZT,
            config.EVIDENCE_AMOUNT_DECIMAL_PLACES,
        )
        return f"{value:g}".replace(".", ",") + " млн"
    if amount >= config.EVIDENCE_THOUSAND_KZT:
        value = round(
            amount / config.EVIDENCE_THOUSAND_KZT,
            config.EVIDENCE_AMOUNT_DECIMAL_PLACES,
        )
        return f"{value:g}".replace(".", ",") + " тыс."
    return f"{round(amount):,}".replace(",", " ")


def _format_percent(value: float) -> str:
    rounded_percent = round(
        value * config.PERCENT_MULTIPLIER,
        config.EVIDENCE_PERCENT_DECIMAL_PLACES,
    )
    return f"{rounded_percent:g}".replace(".", ",")
