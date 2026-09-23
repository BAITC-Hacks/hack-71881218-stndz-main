import pandas as pd
import pytest

from analytics import config
from analytics.temporal import add_temporal_features


def test_fast_share_uses_inclusive_two_day_window_and_sync_counts_distinct_payers() -> None:
    features = pd.DataFrame({"gid": list(range(config.ONE, 10))})
    transactions = pd.DataFrame(
        [
            (9, 1, "2026-07-01", 100.0),
            (1, 2, "2026-07-01", 100.0),
            (1, 3, "2026-07-03", 200.0),
            (1, 4, "2026-07-04", 300.0),
            (5, 2, "2026-07-01", 50.0),
            (5, 2, "2026-07-01", 40.0),
            (6, 2, "2026-07-01", 20.0),
            (7, 2, "2026-07-02", 30.0),
            (8, 2, "2026-07-01", 10.0),
            (3, 4, "2026-07-04", 25.0),
        ],
        columns=config.TRANSACTION_COLUMNS,
    )

    result = add_temporal_features(features, transactions)
    indexed = result.set_index("gid")

    assert indexed.loc[1, "fast_share"] == pytest.approx(0.5)
    assert indexed.loc[5, "fast_share"] == config.ZERO_FLOAT
    assert pd.isna(indexed.loc[4, "fast_share"])
    assert indexed.loc[2, "sync_in_max"] == 4
    assert indexed.loc[4, "sync_in_max"] == 2
    assert indexed["sync_in_max"].dtype == "int64"


def test_temporal_features_handle_empty_history_and_unknown_gids() -> None:
    features = pd.DataFrame({"gid": [1]})
    empty_transactions = pd.DataFrame(
        {
            "src": pd.Series(dtype="int64"),
            "dst": pd.Series(dtype="int64"),
            "date": pd.Series(dtype="datetime64[ns]"),
            "sum_kzt": pd.Series(dtype="float64"),
        }
    )

    result = add_temporal_features(features, empty_transactions)

    assert pd.isna(result.loc[0, "fast_share"])
    assert result.loc[0, "sync_in_max"] == config.ZERO

    unknown_transactions = pd.DataFrame(
        [(1, 2, "2026-07-01", 5000.0)],
        columns=config.TRANSACTION_COLUMNS,
    )
    with pytest.raises(ValueError, match="gids missing from features"):
        add_temporal_features(features, unknown_transactions)


def test_fast_share_preserves_unit_range_for_fractional_amounts() -> None:
    features = pd.DataFrame({"gid": [1, 2, 3]})
    transactions = pd.DataFrame(
        [(1, 2, "2026-07-01", 5000.1)]
        + [(2, 3, "2026-07-02", 5000.1)] * 24,
        columns=config.TRANSACTION_COLUMNS,
    )

    result = add_temporal_features(features, transactions).set_index("gid")

    assert result.loc[2, "fast_share"] == config.ONE_FLOAT
    reordered = add_temporal_features(
        features, transactions.sample(frac=1, random_state=42)
    ).set_index("gid")
    pd.testing.assert_frame_equal(result, reordered, check_exact=True)
