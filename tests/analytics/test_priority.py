from pathlib import Path

import pandas as pd
import pytest

from analytics import config
from analytics.evidence import add_role_evidence
from analytics.features import add_structural_features
from analytics.graph import build_foundation_features, build_graph
from analytics.loader import load_data, validate_data
from analytics.priority import add_priority_scores, build_top_nodes
from analytics.roles import assign_roles
from analytics.temporal import add_temporal_features


ROOT = Path(__file__).resolve().parents[2]


def _priority_row(
    gid: int,
    role: str,
    rank_value: int,
    **overrides: object,
) -> dict[str, object]:
    row: dict[str, object] = {
        "gid": gid,
        "role": role,
        "role_score": config.ROLE_SCORE_MAX,
        "is_seed": False,
        "depth": rank_value,
        "in_deg": rank_value,
        "out_deg": rank_value - config.ONE,
        "in_kzt": float(rank_value * config.MIN_TRANSACTION_KZT),
        "out_kzt": float(rank_value * config.MIN_TRANSACTION_KZT),
        "pass_through": config.ONE_FLOAT,
        "retention": config.ONE_FLOAT,
        "seed_payers": config.ZERO,
        "seed_reach2": config.ZERO,
        "ext_inflow": config.ZERO_FLOAT,
        "pagerank": float(rank_value),
        "betweenness": float(rank_value),
        "fast_share": config.ZERO_FLOAT,
        "sync_in_max": config.ZERO,
        "evidence": f"Признаки роли {role}: {rank_value} наблюдаемых операций.",
        "truncated_by_depth": False,
    }
    row.update(overrides)
    return row


@pytest.fixture(scope="module")
def full_priority_artifacts():
    nodes, edges, transactions = load_data(ROOT / config.DATA_DIR)
    validate_data(nodes, edges, transactions)
    context = build_graph(nodes, edges)
    features = build_foundation_features(nodes, context)
    features = add_structural_features(features, context)
    features = add_temporal_features(features, transactions)
    nodes_roles = add_role_evidence(assign_roles(features))
    nodes_roles = add_priority_scores(nodes_roles)
    return nodes_roles, build_top_nodes(nodes_roles)


def test_priority_weights_apply_d008_seed_multiplier_and_cap() -> None:
    features = pd.DataFrame(
        [
            _priority_row(1, "coordinator", config.ONE),
            _priority_row(
                2,
                "coordinator",
                config.ONE + config.ONE,
                is_seed=True,
            ),
            _priority_row(
                3,
                "boundary",
                config.ONE + config.ONE + config.ONE,
                in_kzt=100000.0,
                out_kzt=1100000.0,
                seed_reach2=config.PRIORITY_SEED_REACH_NORMALIZER,
                ext_inflow=config.EXTERNAL_FUNDING_THRESHOLD_KZT,
                fast_share=config.ONE_FLOAT,
                sync_in_max=config.PRIORITY_SYNC_IN_MAX_NORMALIZER,
                truncated_by_depth=True,
            ),
        ]
    )

    scored = add_priority_scores(features).set_index("gid")
    expected_seed_score = sum(
        config.PRIORITY_WEIGHTS[component] * (2 / 3)
        for component in ("flow", "structure", "volume")
    ) * config.SEED_PRIORITY_MULTIPLIER

    assert scored.loc[1, "priority_score"] == pytest.approx(
        sum(
            config.PRIORITY_WEIGHTS[component] / 3
            for component in ("flow", "structure", "volume")
        )
    )
    assert scored.loc[2, "priority_score"] == pytest.approx(expected_seed_score)
    assert scored.loc[3, "priority_score"] == config.LOW_PRIORITY_CAP
    assert scored["priority_score"].between(config.ZERO_FLOAT, config.ONE_FLOAT).all()

    top_nodes = build_top_nodes(scored.reset_index())
    assert top_nodes["rank"].tolist() == [
        config.ONE,
        config.ONE + config.ONE,
        config.ONE + config.ONE + config.ONE,
    ]
    assert top_nodes["gid"].tolist() == [2, 3, 1]
    assert top_nodes["why"].str.contains("данные:").all()
    assert top_nodes["why"].str.contains(r"\d").all()
    assert top_nodes["why"].str.len().le(config.WHY_MAX_CHARACTERS).all()
    assert not top_nodes["why"].str.contains(
        r"coordinator|boundary|fast_share|sync_in_max|seed"
    ).any()


def test_top_node_why_stays_limited_with_multiple_quality_flags() -> None:
    row = _priority_row(
        1,
        "peripheral",
        config.ONE,
        is_seed=True,
        in_deg=config.ZERO,
        out_deg=config.ZERO,
        in_kzt=config.ZERO_FLOAT,
        out_kzt=config.EXTERNAL_FUNDING_THRESHOLD_KZT,
        ext_inflow=config.EXTERNAL_FUNDING_THRESHOLD_KZT,
        truncated_by_depth=True,
    )

    top_nodes = build_top_nodes(add_priority_scores(pd.DataFrame([row])))
    why = top_nodes.loc[0, "why"]

    assert len(why) <= config.WHY_MAX_CHARACTERS
    assert "Приоритет" in why
    assert "обход ограничен" in why
    assert "входящие неполны" in why


def test_priority_and_temporal_outputs_match_audited_data(full_priority_artifacts) -> None:
    nodes_roles, top_nodes = full_priority_artifacts

    assert nodes_roles["priority_score"].between(config.ZERO_FLOAT, config.ONE_FLOAT).all()
    assert int(nodes_roles["fast_share"].notna().sum()) == (
        config.EXPECTED_FAST_SHARE_NODE_COUNT
    )
    assert nodes_roles["sync_in_max"].median() == config.EXPECTED_SYNC_IN_MAX_MEDIAN
    assert nodes_roles["sync_in_max"].quantile(
        config.EXPECTED_SYNC_IN_MAX_P99_QUANTILE
    ) == (
        config.EXPECTED_SYNC_IN_MAX_P99
    )
    assert nodes_roles["sync_in_max"].max() == config.EXPECTED_SYNC_IN_MAX_VALUE

    isolated = nodes_roles["in_deg"].eq(config.ZERO) & nodes_roles["out_deg"].eq(
        config.ZERO
    )
    capped = nodes_roles["role"].isin(config.PRIORITY_CAPPED_ROLE_NAMES) | isolated
    assert int(capped.sum()) == config.EXPECTED_PRIORITY_CAP_ELIGIBLE_COUNT
    assert nodes_roles.loc[capped, "priority_score"].le(config.LOW_PRIORITY_CAP).all()

    assert len(top_nodes) == config.TOP_NODE_COUNT
    assert top_nodes["rank"].tolist() == list(
        range(config.ONE, config.TOP_NODE_COUNT + config.ONE)
    )
    assert top_nodes["priority_score"].is_monotonic_decreasing
    assert not top_nodes["role"].eq("boundary").any()
    assert top_nodes["why"].str.strip().ne("").all()
    assert top_nodes["why"].str.contains(r"\d").all()
    assert top_nodes["why"].str.contains("данные:").all()
    assert top_nodes["why"].str.contains("быстрые суммы").all()
    assert top_nodes["why"].str.contains("плательщиков за день").all()
    assert top_nodes["why"].str.len().le(config.WHY_MAX_CHARACTERS).all()
