"""Loading and validating the challenge parquet inputs."""

from pathlib import Path

import numpy as np
import pandas as pd

from analytics import config


def _require_columns(frame: pd.DataFrame, expected: tuple[str, ...], name: str) -> None:
    missing = sorted(set(expected) - set(frame.columns))
    if missing:
        raise ValueError(f"{name} is missing required columns: {', '.join(missing)}")


def _require_no_nulls(frame: pd.DataFrame, name: str) -> None:
    null_columns = frame.columns[frame.isna().any()].tolist()
    if null_columns:
        raise ValueError(f"{name} contains null values in: {', '.join(null_columns)}")


def load_data(data_dir: Path = config.DATA_DIR) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Load nodes, edges, and transactions and validate their basic schemas."""
    nodes = pd.read_parquet(data_dir / config.NODES_FILE)
    edges = pd.read_parquet(data_dir / config.EDGES_FILE)
    transactions = pd.read_parquet(data_dir / config.TRANSACTIONS_FILE)

    _require_columns(nodes, config.NODE_COLUMNS, config.NODES_FILE)
    _require_columns(edges, config.EDGE_COLUMNS, config.EDGES_FILE)
    _require_columns(transactions, config.TRANSACTION_COLUMNS, config.TRANSACTIONS_FILE)

    _require_no_nulls(nodes, config.NODES_FILE)
    _require_no_nulls(edges, config.EDGES_FILE)
    _require_no_nulls(transactions, config.TRANSACTIONS_FILE)

    if not pd.api.types.is_integer_dtype(nodes["gid"]):
        raise ValueError("nodes.parquet gid must use an integer type")
    if not pd.api.types.is_integer_dtype(edges["src"]) or not pd.api.types.is_integer_dtype(edges["dst"]):
        raise ValueError("edges.parquet src and dst must use integer types")
    if not pd.api.types.is_integer_dtype(transactions["src"]) or not pd.api.types.is_integer_dtype(transactions["dst"]):
        raise ValueError("transactions.parquet src and dst must use integer types")
    if not pd.api.types.is_bool_dtype(nodes["is_seed"]):
        raise ValueError("nodes.parquet is_seed must use a boolean type")

    try:
        transactions = transactions.copy()
        transactions["date"] = pd.to_datetime(transactions["date"], errors="raise")
    except (TypeError, ValueError) as error:
        raise ValueError("transactions.parquet date contains invalid values") from error

    return nodes, edges, transactions


def validate_data(
    nodes: pd.DataFrame,
    edges: pd.DataFrame,
    transactions: pd.DataFrame,
) -> dict[str, int | float | str]:
    """Validate the challenge invariants and return an aggregate quality report."""
    expected_counts = {
        "nodes": (len(nodes), config.EXPECTED_NODE_COUNT),
        "edges": (len(edges), config.EXPECTED_EDGE_COUNT),
        "transactions": (len(transactions), config.EXPECTED_TRANSACTION_COUNT),
        "seeds": (int(nodes["is_seed"].sum()), config.EXPECTED_SEED_COUNT),
    }
    mismatched_counts = {
        name: (actual, expected)
        for name, (actual, expected) in expected_counts.items()
        if actual != expected
    }
    if mismatched_counts:
        details = ", ".join(
            f"{name}={actual} (expected {expected})"
            for name, (actual, expected) in mismatched_counts.items()
        )
        raise ValueError(f"Input row counts do not match the audited dataset: {details}")

    if nodes["gid"].duplicated().any():
        raise ValueError("nodes.parquet contains duplicate gid values")
    if edges.duplicated(["src", "dst"]).any():
        raise ValueError("edges.parquet contains duplicate src/dst pairs")
    if edges["src"].eq(edges["dst"]).any():
        raise ValueError("edges.parquet contains self-loops")

    known_gids = set(nodes["gid"].astype("int64"))
    edge_gids = set(edges["src"].astype("int64")) | set(edges["dst"].astype("int64"))
    transaction_gids = set(transactions["src"].astype("int64")) | set(
        transactions["dst"].astype("int64")
    )
    unknown_edge_gids = edge_gids - known_gids
    unknown_transaction_gids = transaction_gids - known_gids
    if unknown_edge_gids:
        raise ValueError(f"edges.parquet references {len(unknown_edge_gids)} unknown node IDs")
    if unknown_transaction_gids:
        raise ValueError(
            f"transactions.parquet references {len(unknown_transaction_gids)} unknown node IDs"
        )

    edge_amounts = edges["sum_kzt"].to_numpy(dtype="float64")
    transaction_amounts = transactions["sum_kzt"].to_numpy(dtype="float64")
    if not np.isfinite(edge_amounts).all() or not np.isfinite(transaction_amounts).all():
        raise ValueError("Input amounts must all be finite numbers")
    if (transaction_amounts < config.MIN_TRANSACTION_KZT).any():
        raise ValueError(
            f"transactions.parquet contains transfers below {config.MIN_TRANSACTION_KZT} KZT"
        )

    transaction_pairs = (
        transactions.groupby(["src", "dst"], as_index=False, sort=True)
        .agg(tx_sum=("sum_kzt", "sum"), tx_count=("sum_kzt", "size"))
    )
    pair_comparison = edges[["src", "dst", "sum_kzt", "n_tx"]].merge(
        transaction_pairs,
        on=["src", "dst"],
        how="outer",
        indicator=True,
        validate="one_to_one",
    )
    unmatched_pairs = pair_comparison["_merge"].ne("both")
    if unmatched_pairs.any():
        raise ValueError(
            "edges.parquet and transactions.parquet have "
            f"{int(unmatched_pairs.sum())} unmatched src/dst pairs"
        )

    amount_matches = np.isclose(
        pair_comparison["sum_kzt"].to_numpy(dtype="float64"),
        pair_comparison["tx_sum"].to_numpy(dtype="float64"),
        rtol=config.EDGE_SUM_REL_TOLERANCE,
        atol=config.EDGE_SUM_ABS_TOLERANCE_KZT,
    )
    count_matches = pair_comparison["n_tx"].eq(pair_comparison["tx_count"]).to_numpy()
    mismatched_pairs = ~(amount_matches & count_matches)
    if mismatched_pairs.any():
        raise ValueError(
            "edges.parquet and transactions.parquet differ in sum_kzt or n_tx for "
            f"{int(mismatched_pairs.sum())} src/dst pairs"
        )

    incident_gids = edge_gids
    isolated_gids = known_gids - incident_gids
    if len(isolated_gids) != config.EXPECTED_ISOLATED_COUNT:
        raise ValueError(
            f"Expected {config.EXPECTED_ISOLATED_COUNT} isolated nodes; found {len(isolated_gids)}"
        )

    date_min = transactions["date"].min().date().isoformat()
    date_max = transactions["date"].max().date().isoformat()
    if (date_min, date_max) != (config.EXPECTED_START_DATE, config.EXPECTED_END_DATE):
        raise ValueError(f"Unexpected transaction period: {date_min} — {date_max}")

    return {
        "nodes": len(nodes),
        "edges": len(edges),
        "transactions": len(transactions),
        "seeds": int(nodes["is_seed"].sum()),
        "isolated": len(isolated_gids),
        "turnover_kzt": float(edges["sum_kzt"].sum()),
        "date_min": date_min,
        "date_max": date_max,
    }


def print_quality_report(report: dict[str, int | float | str]) -> None:
    """Print a compact Russian-language input quality summary."""
    print("ПРОВЕРКА ДАННЫХ")
    print(f"  узлов: {report['nodes']}; рёбер: {report['edges']}; транзакций: {report['transactions']}")
    print(f"  seed: {report['seeds']}; изолированных узлов: {report['isolated']}")
    print(f"  оборот: {report['turnover_kzt']:,.2f} KZT")
    print(f"  период: {report['date_min']} — {report['date_max']}")
    print("  сверка рёбер с транзакциями: OK")
