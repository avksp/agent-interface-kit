---
name: aik-source-adapter
description: Develop or review Agent Interface Kit source adapters. Use this when capturing Figma selections, importing editor exports, or changing the snapshot, provenance, asset, or source-fact contract.
---

# AIK source adapter

Read the data boundaries and editor capture sections. Identify the real entry point, source version, capture scope, and available resources. [Architecture](../../../docs/architecture.md)

- Save the input bytes and hashes, source version, links, and stable source IDs. Preserve child order. Check the archive size and schema version before you read its contents.
- Keep editor access in the capture step. Save assets behind temporary links as bytes. If a required asset, token, or component is missing, emit a diagnostic with its `sourceRef`.
- Map observed properties to source facts. If a role or action depends on user intent, leave the decision to an explicit rule or catalog binding.
- Test a permitted export from the real editor. Replay the saved snapshot offline. Test one invalid case for that version. Record the host, input digest, and support boundary. [Verification](../../../docs/verification.md)
