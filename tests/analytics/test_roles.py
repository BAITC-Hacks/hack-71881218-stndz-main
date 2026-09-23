import ast
import re
from pathlib import Path

import pandas as pd

from analytics import config
from analytics.evidence import add_role_evidence
from analytics.roles import assign_roles


def _feature_row(gid: int, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "gid": gid,
        "depth": 1,
        "is_seed": False,
        "in_deg": 1,
        "out_deg": 1,
        "in_kzt": 100000.0,
        "out_kzt": 100000.0,
        "pass_through": 1.0,
        "retention": 0.0,
        "seed_reach2": 0,
        "seed_payers": 0,
        "truncated_by_depth": False,
    }
    row.update(overrides)
    return row


def test_assign_roles_obeys_rule_order_and_observability_limits() -> None:
    features = pd.DataFrame(
        [
            _feature_row(1, in_deg=5, out_deg=10),
            _feature_row(2, out_deg=10),
            _feature_row(
                3,
                in_deg=config.CONSOLIDATOR_ALT_MIN_IN_DEGREE,
                in_kzt=float(config.CONSOLIDATOR_IN_KZT_P95),
                out_deg=0,
                pass_through=0.0,
                retention=1.0,
            ),
            _feature_row(4, in_deg=1, out_deg=1, pass_through=0.9, retention=0.1),
            _feature_row(5, depth=3, in_deg=1, out_deg=1, pass_through=0.2, retention=0.8),
            _feature_row(6, depth=4, out_deg=0, pass_through=0.0, retention=1.0),
            _feature_row(7, is_seed=True, pass_through=1.0),
        ]
    )

    assigned = assign_roles(features)
    explained = add_role_evidence(assigned)

    assert assigned["role"].tolist() == [
        "coordinator",
        "distributor",
        "consolidator",
        "transit",
        "terminal",
        "boundary",
        "peripheral",
    ]
    assert assigned["role_score"].between(config.ROLE_SCORE_MIN, config.ROLE_SCORE_MAX).all()
    assert explained["evidence"].str.len().le(config.EVIDENCE_MAX_CHARACTERS).all()
    assert explained["evidence"].map(
        lambda text: any(character.isdigit() for character in text)
    ).all()
    assert (
        "Входящие извне выборки не наблюдаются"
        in explained.loc[6, "evidence"]
    )
    assert "исходящие здесь не собирались" in explained.loc[5, "evidence"]


def test_monetary_consolidator_requires_minimum_in_degree() -> None:
    features = pd.DataFrame(
        [
            _feature_row(
                1,
                in_deg=config.CONSOLIDATOR_ALT_MIN_IN_DEGREE - 1,
                in_kzt=float(config.CONSOLIDATOR_IN_KZT_P95),
                out_deg=0,
                pass_through=0.0,
                retention=1.0,
            )
        ]
    )

    assigned = assign_roles(features)

    assert assigned.loc[0, "role"] == "terminal"


def test_transit_score_uses_fast_share_bonus_when_available() -> None:
    features = pd.DataFrame(
        [
            _feature_row(
                1,
                in_deg=1,
                out_deg=1,
                pass_through=0.9,
                retention=0.1,
                fast_share=config.ROLE_SCORE_FAST_SHARE_MIN,
            )
        ]
    )

    assigned = assign_roles(features)
    expected_score = round(
        config.ROLE_SCORE_MAX
        - config.ROLE_SCORE_TRANSIT_DISTANCE_MULTIPLIER
        * abs(0.9 - config.ONE_FLOAT)
        + config.ROLE_SCORE_FAST_SHARE_BONUS,
        config.ROLE_SCORE_DECIMAL_PLACES,
    )

    assert assigned.loc[0, "role"] == "transit"
    assert assigned.loc[0, "role_score"] == expected_score


def test_analytics_sources_contain_no_literal_gids() -> None:
    analytics_dir = Path(__file__).resolve().parents[2] / "analytics"
    gid_pattern = re.compile(r"\b\d{15,}\b")

    source_files = analytics_dir.glob("*.py")

    assert all(
        gid_pattern.search(path.read_text(encoding="utf-8")) is None
        for path in source_files
    )


def test_analytics_numeric_constants_live_in_config() -> None:
    analytics_dir = Path(__file__).resolve().parents[2] / "analytics"
    source_files = [path for path in analytics_dir.glob("*.py") if path.name != "config.py"]
    numeric_constants = []
    for path in source_files:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        numeric_constants.extend(
            (path.name, node.lineno, node.value)
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, (int, float))
            and not isinstance(node.value, bool)
        )

    assert numeric_constants == []
