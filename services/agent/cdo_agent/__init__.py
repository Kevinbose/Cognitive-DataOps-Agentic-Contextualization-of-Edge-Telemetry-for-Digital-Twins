"""Cognitive DataOps diagnosis agent.

Two lanes over one set of tools:

- Diagnose: the anomaly detector in the Node API opens an investigation and
  hands it here. A LangGraph pipeline reads the machine over MCP, computes the
  features the knowledge base defines, scores the documented fault signatures,
  retrieves evidence from the RAG module, grounds the result on the twin's
  meshes and posts a cited report.
- Converse: the twin's chat widget. Plant scope (all twins) or twin scope (one
  twin, the selected part). A Gemini tool loop when a key is configured, a
  rule-based answerer when it is not.
"""

__version__ = "0.1.0"
