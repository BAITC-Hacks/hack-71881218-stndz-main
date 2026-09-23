"""Date-aware transaction features for short-window flow analysis."""

import numpy as np
import pandas as pd

from analytics import config


TEMPORAL_TRANSACTION_COLUMNS = ("src", "dst", "date", "sum_kzt")


def add_temporal_features(
    features: pd.DataFrame,
    transactions: pd.DataFrame,
) -> pd.DataFrame:
    """Add temporal features to every node.

    ``fast_share`` is the fraction of outgoing KZT whose transfer date has at
    least one incoming transaction in the inclusive window from that date
    minus ``FAST_TRANSFER_WINDOW_DAYS`` through the transfer date. It is
    undefined when a node has no observed outgoing transaction. ``sync_in_max``
    is the maximum number of distinct incoming payers on one calendar day; it
    is zero when the node has no observed incoming transaction.
    """
    missing_feature_columns = sorted({"gid"} - set(features.columns))
    if missing_feature_columns:
        raise ValueError(
            "Temporal feature table is missing columns: "
            f"{', '.join(missing_feature_columns)}"
        )
    missing_transaction_columns = sorted(
        set(TEMPORAL_TRANSACTION_COLUMNS) - set(transactions.columns)
    )
    if missing_transaction_columns:
        raise ValueError(
            "Temporal transaction table is missing columns: "
            f"{', '.join(missing_transaction_columns)}"
        )
    if features["gid"].isna().any() or features["gid"].duplicated().any():
        raise ValueError("Temporal feature table must contain unique, non-null gids")
    if transactions[list(TEMPORAL_TRANSACTION_COLUMNS)].isna().any().any():
        raise ValueError("Temporal transaction table contains null values")

    transaction_rows = transactions.loc[:, TEMPORAL_TRANSACTION_COLUMNS].copy()
    try:
        transaction_rows["date"] = pd.to_datetime(
            transaction_rows["date"],
            errors="raise",
        )
    except (TypeError, ValueError) as error:
        raise ValueError("Temporal transaction dates contain invalid values") from error
    if transaction_rows["date"].isna().any():
        raise ValueError("Temporal transaction dates contain null values")

    amounts = transaction_rows["sum_kzt"].to_numpy(dtype="float64")
    if not np.isfinite(amounts).all() or (amounts < config.ZERO_FLOAT).any():
        raise ValueError("Temporal transaction amounts must be finite and non-negative")

    node_gids = set(features["gid"].astype("int64"))
    transaction_gids = set(transaction_rows["src"].astype("int64")) | set(
        transaction_rows["dst"].astype("int64")
    )
    if transaction_gids - node_gids:
        raise ValueError("Temporal transaction table references gids missing from features")

    incoming_dates = {
        int(gid): tuple(sorted(pd.Timestamp(date) for date in group["date"].unique()))
        for gid, group in transaction_rows.groupby("dst", sort=True)
    }
    observation_window = pd.Timedelta(days=config.FAST_TRANSFER_WINDOW_DAYS)
    fast_share_by_gid = {}
    for gid, outgoing_rows in transaction_rows.groupby("src", sort=True):
        recent_incoming_dates = incoming_dates.get(int(gid), ())
        matched_outgoing_amount = config.ZERO_FLOAT
        total_outgoing_amount = float(outgoing_rows["sum_kzt"].sum())
        for transfer in outgoing_rows.itertuples(index=False):
            transfer_date = pd.Timestamp(transfer.date)
            window_start = transfer_date - observation_window
            if any(
                window_start <= incoming_date <= transfer_date
                for incoming_date in recent_incoming_dates
            ):
                matched_outgoing_amount += float(transfer.sum_kzt)
        fast_share_by_gid[int(gid)] = (
            matched_outgoing_amount / total_outgoing_amount
            if total_outgoing_amount > config.ZERO_FLOAT
            else np.nan
        )

    daily_payer_counts = (
        transaction_rows.assign(transaction_day=transaction_rows["date"].dt.normalize())
        .groupby(["dst", "transaction_day"], sort=True)["src"]
        .nunique()
    )
    if daily_payer_counts.empty:
        sync_in_max_by_gid = pd.Series(dtype="int64")
    else:
        sync_in_max_by_gid = daily_payer_counts.groupby(level="dst", sort=True).max()

    result = features.copy()
    result["fast_share"] = result["gid"].map(fast_share_by_gid).astype("float64")
    result["sync_in_max"] = (
        result["gid"].map(sync_in_max_by_gid).fillna(config.ZERO).astype("int64")
    )
    defined_fast_share = result["fast_share"].dropna()
    if not defined_fast_share.between(config.ZERO_FLOAT, config.ONE_FLOAT).all():
        raise ValueError("fast_share must stay within the configured [0, 1] range")

    return result.sort_values("gid", kind="mergesort").reset_index(drop=True)
