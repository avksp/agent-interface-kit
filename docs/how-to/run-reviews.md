# Run solution reviews and code audits

[Russian version](../ru/how-to/run-reviews.md)

## Choose a reviewer

1. Classify the review by its risk. If architecture, security, or complex logic is in scope, use the critical route.
2. Print the route with `npm run review:route -- architecture`. Replace `architecture` with the subject. The [policy](../../config/review-policy.json) defines the order, and its [schema](../../schemas/review-policy.v1.schema.json) checks the shape.
3. Confirm the exact adapter, model, and reasoning effort on the current host before dispatch. Move to the next listed candidate only when the earlier route is unavailable before dispatch. Record the reason. A timeout or adverse finding remains in the review history.
4. For ALK managed runs, use the approved local host binding with the same model and effort. The host binding needs its own support and qualification evidence. For ARS, record the same route in the caller assignment. The project policy selects candidates for both tools. Model launch and authorization use the tool's own workflow.

| Review | Order |
| --- | --- |
| Solution, architecture, security, complex logic | Codex · `gpt-6.2-astra` · `high` |
| Other audits | Qwen Code · `qwen4-max` · `high`, Qwen Code · `deepseek-v4-pro-0813` · `high`, Grok Build · `grok-4.7` · `high`, OpenCode · GLM 5.3 · `max` |
| Simple analysis or audit | OpenCode · GLM 5.3 · `max` |

The OpenCode model selector is `zai-coding-plan/glm-5.3#max`. In Qwen, an advertised model with no verified `high` parameter is an unavailable exact route. Confirm the effective effort before trying the next one.

## Review a solution before freeze

1. Prepare a read-only packet with the exact draft revision, scope, requirements, verification criteria, and relevant source or feasibility evidence.
2. Use the independent `ars-review-solution` role. Require a comparison with the current approach and meaningful alternatives. Ask for fit, integration, security, resources, feasibility, and testability.
3. Bind the ARS request and output to the exact packet. Validate the report against separate caller expectations. Check findings and real gaps before accepting the solution.
4. Resolve blocking findings or rework the plan. Retain the report and verification in `tasks/reviews/`. Record the exact packet and the disposition.
5. Complete the ALK plan review and freeze only after the solution review meets its gate. Use the normal ALK authorization for execution.

## Run the periodic audit

1. Count shipped releases since the last complete audit. Run the audit after three releases if any changed a public contract, compiler pipeline, or trust boundary across layers. Otherwise run it after four.
2. Bind the released Git revision, relevant diffs, test results, and a reproducible performance baseline.
3. Use ARS to check architecture, security, engineering practices, and measured performance. Use `ars-review-security` for defensive security and `ars-review-implementation` for changed code and evidence. Apply the review route to each subject.
4. Record findings, coverage gaps, and fixes with verification. Compare performance only in matched environments. Keep the architecture and security requirements as acceptance conditions.
5. Reset the release count after the complete audit is accepted. Keep previous reports and unknown telemetry.
