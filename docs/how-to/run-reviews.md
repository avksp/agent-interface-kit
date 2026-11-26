# Run solution reviews and code audits

[Russian version](../ru/how-to/run-reviews.md)

## Choose a reviewer

1. Classify the review by its risk. If architecture, security, or complex logic is in scope, use the critical route.
2. Print the route with `npm run review:route -- architecture`. Replace `architecture` with the subject. The [policy](../../config/review-policy.json) defines the order, and its [schema](../../schemas/review-policy.v1.schema.json) checks the shape.
3. Before dispatch, confirm the exact adapter, model, and reasoning effort on the current host. You MUST move to the next listed candidate only if the earlier candidate is unavailable. Record the reason. A timeout or adverse finding remains in the review history.
4. For ALK managed runs, use the approved local host binding with the same model and effort. The host binding needs its own support and qualification evidence. For ARS, record the same route in the caller assignment. The project policy selects candidates for both tools. Model launch and authorization use the tool's own workflow.

| Review | Order |
| --- | --- |
| Solution, architecture, security, complex logic | Codex · `gpt-6.2-astra` · `high` |
| Other ARS audits | GitHub Copilot CLI · MAI Code 2 · `xhigh`, OpenCode · Z.AI Coding Plan · GLM 5.4 · `max` |
| Routine ALK plan or task audit, simple analysis | OpenCode · Z.AI Coding Plan · GLM 5.4 · `max`, GitHub Copilot CLI · MAI Code 2 · `xhigh`, GitHub Copilot CLI · Gemini 4 Hydrogen · `high` |

Use `npm run review:route -- alk-plan` for routine plan audits and `npm run review:route -- alk-task` for routine task audits. The `copilot` adapter ID refers to GitHub Copilot CLI. Use model ID `zai-coding-plan/glm-5.4` with OpenCode variant `max`. In Copilot CLI, use `--model mai-code-2 --reasoning-effort xhigh` or `--model gemini-4-hydrogen --reasoning-effort high`. A candidate is unavailable if the host cannot confirm the required effort.

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
