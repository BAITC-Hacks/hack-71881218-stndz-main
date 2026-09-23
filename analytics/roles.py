"""Ordered, explainable role assignment for graph nodes."""

import math

import pandas as pd

from analytics import config


ROLE_FEATURE_COLUMNS = (
    "gid",
    "depth",
    "is_seed",
    "in_deg",
    "out_deg",
    "in_kzt",
    "out_kzt",
    "pass_through",
    "retention",
    "seed_reach2",
)


def assign_roles(features: pd.DataFrame) -> pd.DataFrame:
    """Assign the first matching role and its rule-specific confidence score."""
    missing_columns = sorted(set(ROLE_FEATURE_COLUMNS) - set(features.columns))
    if missing_columns:
        raise ValueError(f"Role features are missing columns: {', '.join(missing_columns)}")

    result = features.copy()
    if result["gid"].isna().any() or result["gid"].duplicated().any():
        raise ValueError("Role features must contain unique, non-null gids")
    if result[list(set(ROLE_FEATURE_COLUMNS) - {"pass_through"})].isna().any().any():
        raise ValueError("Role features contain missing values required by role rules")

    roles = []
    scores = []
    for record in result.to_dict(orient="records"):
        role, score = _classify_node(record)
        roles.append(role)
        scores.append(score)

    result["role"] = roles
    result["role_score"] = scores
    result["role_score"] = result["role_score"].astype("float64")

    if not result["role"].isin(config.ROLE_NAMES).all():
        raise ValueError("Role assignment produced a value outside the role dictionary")
    if not result["role_score"].between(config.ROLE_SCORE_MIN, config.ROLE_SCORE_MAX).all():
        raise ValueError("Role scores must stay within the configured range")
    if (result.loc[result["is_seed"], "role"] == "transit").any():
        raise ValueError("Seed nodes cannot be assigned the transit role")

    return result.sort_values("gid", kind="mergesort").reset_index(drop=True)


def _classify_node(record: dict) -> tuple[str, float]:
    in_degree = int(record["in_deg"])
    out_degree = int(record["out_deg"])
    depth = int(record["depth"])
    is_seed = bool(record["is_seed"])
    pass_through = record["pass_through"]
    retention = float(record["retention"])
    seed_reach2 = int(record["seed_reach2"])

    if (
        in_degree >= config.COORDINATOR_MIN_IN_DEGREE
        and out_degree >= config.COORDINATOR_MIN_OUT_DEGREE
    ):
        strength = math.sqrt(
            (in_degree / config.COORDINATOR_MIN_IN_DEGREE)
            * (out_degree / config.COORDINATOR_MIN_OUT_DEGREE)
        ) / config.ROLE_SCORE_COORDINATOR_NORMALIZER
        return "coordinator", _scaled_score(strength)

    if out_degree >= config.DISTRIBUTOR_MIN_OUT_DEGREE:
        strength = out_degree / config.ROLE_SCORE_DISTRIBUTOR_NORMALIZER
        return "distributor", _scaled_score(strength)

    is_consolidator = (
        in_degree >= config.CONSOLIDATOR_MIN_IN_DEGREE
        or (
            in_degree >= config.CONSOLIDATOR_ALT_MIN_IN_DEGREE
            and seed_reach2 >= config.CONSOLIDATOR_MIN_SEED_REACH
        )
        or (
            in_degree >= config.CONSOLIDATOR_ALT_MIN_IN_DEGREE
            and float(record["in_kzt"]) >= config.CONSOLIDATOR_IN_KZT_P95
        )
    )
    if is_consolidator:
        strength = max(
            in_degree / config.ROLE_SCORE_CONSOLIDATOR_IN_DEGREE_NORMALIZER,
            seed_reach2 / config.ROLE_SCORE_CONSOLIDATOR_SEED_REACH_NORMALIZER,
        )
        return "consolidator", _scaled_score(strength)

    if (
        not is_seed
        and in_degree > config.ZERO
        and out_degree > config.ZERO
        and pd.notna(pass_through)
        and config.TRANSIT_PASS_THROUGH_MIN
        <= float(pass_through)
        <= config.TRANSIT_PASS_THROUGH_MAX
    ):
        score = config.ROLE_SCORE_MAX - config.ROLE_SCORE_TRANSIT_DISTANCE_MULTIPLIER * abs(
            float(pass_through) - config.ONE_FLOAT
        )
        fast_share = record.get("fast_share")
        if pd.notna(fast_share) and fast_share >= config.ROLE_SCORE_FAST_SHARE_MIN:
            score += config.ROLE_SCORE_FAST_SHARE_BONUS
        return "transit", _bounded_score(score)

    if (
        depth < config.BOUNDARY_DEPTH
        and in_degree > config.ZERO
        and retention >= config.TERMINAL_RETENTION_MIN
    ):
        depth_score = (
            config.ROLE_SCORE_TERMINAL_NEAR_BOUNDARY
            if depth <= config.ROLE_SCORE_TERMINAL_NEAR_BOUNDARY_DEPTH
            else config.ROLE_SCORE_TERMINAL_FARTHER
        )
        return "terminal", _bounded_score(depth_score * retention)

    if depth == config.BOUNDARY_DEPTH and out_degree == config.ZERO:
        return "boundary", _bounded_score(config.ROLE_SCORE_MIN)

    return "peripheral", _bounded_score(config.ROLE_SCORE_MIN)


def _scaled_score(strength: float) -> float:
    bounded_strength = min(config.ONE_FLOAT, max(config.ZERO_FLOAT, strength))
    score = config.ROLE_SCORE_MIN + (
        config.ROLE_SCORE_MAX - config.ROLE_SCORE_MIN
    ) * bounded_strength
    return _bounded_score(score)


def _bounded_score(score: float) -> float:
    return round(
        min(config.ROLE_SCORE_MAX, max(config.ROLE_SCORE_MIN, score)),
        config.ROLE_SCORE_DECIMAL_PLACES,
    )
