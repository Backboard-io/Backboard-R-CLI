# RLM Test Environment

This folder is a small, self-contained fixture for manually testing the JavaScript RLM runtime. It is designed to exercise the intended DSPy-style surface:

- `context` and `task`
- structured `inputs`
- direct variable bindings like `files`, `tickets`, and `metrics`
- `print(...)`, `inspect(...)`, `state`
- `llm_query(...)` and `llm_query_batched(...)`
- `SUBMIT(...)`
- timeout partial summaries

The RLM should not need filesystem tools for these prompts. The parent agent should gather or provide the fixture data as `variables`.

## Fixture Files

- `variables.json`: ready-to-pass structured variables.
- `src/cart.ts`: intentionally small code sample with a pricing bug.
- `src/discounts.ts`: helper code used by `cart.ts`.
- `data/tickets.json`: support tickets with priority/severity signals.
- `data/metrics.json`: product metrics with an anomaly.
- `notes/architecture.md`: short architecture notes with a few constraints.
- `notes/release-plan.md`: release checklist with a deliberate conflict.

## Recommended RLM Variables

Use the contents of `variables.json` as the `variables` argument to the `Agent` tool when `subagent_type` is `"rlm"`.

The important variable names are:

- `files`: array of `{ path, text }`
- `tickets`: support-ticket objects
- `metrics`: metric rows
- `constraints`: product and runtime constraints
- `releasePlan`: release checklist text
- `context`: intentionally conflicts with the reserved runtime `context` binding

The reserved-name conflict is intentional. Inside RLM code, `context` should still be the prompt string, while `inputs.context` should contain the fixture-provided value.

## Prompt 1: Code Bug Hunt

Ask the parent agent:

```text
Use Agent with subagent_type "rlm". Load tests/rlm_env/variables.json and pass it as variables. Ask the RLM to inspect files and find the pricing bug. It should use JavaScript over the provided variables only, print intermediate findings, and SUBMIT a JSON object with keys: bug, evidence, fix, risk.
```

Expected result:

- It identifies that `cart.ts` applies a negative discount incorrectly.
- It points at `applyDiscount(subtotal, -item.discountCents)`.
- It proposes passing a positive discount amount or renaming the helper/argument contract.

## Prompt 2: Ticket Triage

Ask the parent agent:

```text
Use Agent with subagent_type "rlm". Load tests/rlm_env/variables.json and pass it as variables. Ask the RLM to rank the support tickets by urgency. It should compute a score in JavaScript, print the ranked ticket ids, and SUBMIT an array of objects with id, score, reason.
```

Expected result:

- `TCK-103` should rank high because it combines checkout errors, high severity, and revenue impact.
- `TCK-101` should also rank high because login failures affect many users.
- Low-impact copy issues should rank lower.

## Prompt 3: Metrics Anomaly

Ask the parent agent:

```text
Use Agent with subagent_type "rlm". Load tests/rlm_env/variables.json and pass it as variables. Ask the RLM to detect anomalies in metrics. It should compare current values against baselines, print any percentage deltas over 20%, and SUBMIT a concise markdown report with findings and likely causes.
```

Expected result:

- It should flag checkout error rate and conversion drop.
- It should connect those metrics to the checkout support tickets and cart pricing bug.

## Prompt 4: Architecture Constraint Check

Ask the parent agent:

```text
Use Agent with subagent_type "rlm". Load tests/rlm_env/variables.json and pass it as variables. Ask the RLM to compare releasePlan against constraints and find conflicts. It should SUBMIT a JSON object with conflicts, nonConflicts, and recommendedReleaseDecision.
```

Expected result:

- It should flag the conflict between "no schema migrations" and the release plan's migration task.
- It should mention that checkout changes need focused validation.

## Prompt 5: Reserved Binding Check

Ask the parent agent:

```text
Use Agent with subagent_type "rlm". Load tests/rlm_env/variables.json and pass it as variables. Ask the RLM to verify reserved binding behavior. It should print typeof SUBMIT, print whether context equals task, print inputs.context.label, and SUBMIT a JSON object proving direct context was not overwritten.
```

Expected result:

- `typeof SUBMIT` is `function`.
- `context` is the prompt string, not the `variables.context` object.
- `inputs.context.label` is available.

## Prompt 6: Recursive LLM Calls

Ask the parent agent:

```text
Use Agent with subagent_type "rlm". Load tests/rlm_env/variables.json and pass it as variables. Ask the RLM to use llm_query_batched to ask for three independent short hypotheses: one for the pricing bug, one for support-ticket urgency, and one for release risk. It should print the responses and SUBMIT a synthesized final recommendation.
```

Expected result:

- It exercises `llm_query_batched`.
- It still grounds the final answer in the provided variables.

## Prompt 7: Timeout Partial Summary

Ask the parent agent:

```text
Use Agent with subagent_type "rlm" and timeout_ms 1000. Load tests/rlm_env/variables.json and pass it as variables. Ask the RLM to inspect files, print the file paths it sees, then intentionally run a long synchronous loop before SUBMIT. We want to verify the parent receives a timed-out partial-progress report.
```

Expected result:

- The RLM should time out.
- The final Agent output should show status `timed_out`.
- The transcript should include a useful partial summary rather than only the round count.

## Direct Agent Tool Shape

When constructing the Agent tool call directly, use this shape:

```json
{
  "subagent_type": "rlm",
  "prompt": "Inspect the provided files and find the pricing bug. Use only variables, print intermediate findings, and SUBMIT a JSON object with bug, evidence, fix, risk.",
  "variables": {
    "files": [],
    "tickets": [],
    "metrics": [],
    "constraints": {},
    "releasePlan": ""
  },
  "timeout_ms": 300000
}
```

Replace `variables` with the full contents of `variables.json`.
