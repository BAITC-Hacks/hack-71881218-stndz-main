"""Run the graph foundation, structural features, and role analysis."""

import argparse
from pathlib import Path

from analytics import config
from analytics.export import (
    build_graph_payload,
    add_pending_phase_fields,
    make_empty_exports,
    write_csv_exports,
    write_graph_json,
)
from analytics.evidence import add_role_evidence
from analytics.features import add_structural_features
from analytics.graph import build_foundation_features, build_graph
from analytics.loader import load_data, print_quality_report, validate_data
from analytics.roles import assign_roles


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build MoneyGraph AI graph and role exports")
    parser.add_argument("--data-dir", type=Path, default=config.DATA_DIR)
    parser.add_argument("--output-dir", type=Path, default=config.OUTPUT_DIR)
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    nodes, edges, transactions = load_data(arguments.data_dir)
    report = validate_data(nodes, edges, transactions)
    print_quality_report(report)

    graph_context = build_graph(nodes, edges)
    features = build_foundation_features(nodes, graph_context)
    features = add_structural_features(features, graph_context)
    nodes_roles = assign_roles(features)
    nodes_roles = add_role_evidence(nodes_roles)
    nodes_roles = add_pending_phase_fields(nodes_roles)
    clusters, top_nodes = make_empty_exports()

    write_csv_exports(nodes_roles, clusters, top_nodes, arguments.output_dir)
    graph_payload = build_graph_payload(nodes_roles, edges, transactions, graph_context)
    write_graph_json(graph_payload, arguments.output_dir)

    print(
        "Граф собран: "
        f"{graph_context.graph.number_of_nodes()} узлов, "
        f"{graph_context.graph.number_of_edges()} рёбер, "
        f"{len(graph_context.component_sizes)} компонент"
    )
    print(f"Экспорты записаны в {arguments.output_dir}")


if __name__ == "__main__":
    main()
