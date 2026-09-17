"""Benchmark TypeSafe Jev against chat LLMs on coding-agent judgments.

Two tasks model decisions a coding agent (Pi) makes many times per session:

* ``tool_gate``: given a tool call, decide allow / confirm / block.
* ``agent_question``: given the conversation so far and a question the
  agent wants to ask the user, decide whether the context already answers
  it and, if so, which option.

Every provider answers the same closed-set question plus one yes/no
probability, so accuracy, calibration, consistency, latency and cost are
directly comparable.
"""
