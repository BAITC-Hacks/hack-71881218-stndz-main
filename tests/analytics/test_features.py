import networkx as nx
import pandas as pd
import pytest

from analytics import config
from analytics.features import add_structural_features
from analytics.graph import GraphContext, build_foundation_features


def test_seed_walks_and_undefined_retention_preserve_decisions(monkeypatch) -> None:
    nodes = pd.DataFrame(
        {"gid": [1, 2, 3], "depth": [0, 1, 0], "is_seed": [True, False, True]}
    )
    graph = nx.DiGraph()
    graph.add_nodes_from(nodes.gid)
    graph.add_edge(1, 2, sum_kzt=5000.0, n_tx=1)
    graph.add_edge(2, 1, sum_kzt=10000.0, n_tx=2)
    context = GraphContext(
        graph=graph,
        component_ids={1: 0, 2: 0, 3: 1},
        component_sizes={0: 2, 1: 1},
        predecessors={1: (2,), 2: (1,), 3: ()},
        successors={1: (2,), 2: (1,), 3: ()},
        edge_component_sizes=(2,),
    )
    monkeypatch.setattr(config, "EXPECTED_UNOBSERVED_INFLOW_COUNT", 1)

    features = add_structural_features(
        build_foundation_features(nodes, context), context
    ).set_index("gid")

    assert features.seed_payers.to_dict() == {1: 0, 2: 1, 3: 0}
    assert features.seed_reach2.to_dict() == {1: 1, 2: 1, 3: 0}
    assert features.retention.to_dict() == {1: 0.5, 2: -1.0, 3: 0.0}
    assert pd.isna(features.loc[3, "pass_through"])
    assert features.loc[3, "pagerank"] > 0
    assert features.pagerank.sum() == pytest.approx(1.0)
    assert features.betweenness.eq(0).all()
