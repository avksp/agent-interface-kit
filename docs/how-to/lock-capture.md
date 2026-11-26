# Lock a capture

Create a private staging directory on the capture volume. Use a separate directory with mode 0700, your effective user as owner, and no extended ACL. Keep its permissions and temporary names under your control until lock publication finishes. Use a volume that enforces ownership and supports exclusive rename.

Pass its absolute path to the lock command.

```sh
aik lock --input ./capture --overlay ./capture/overlay.json --out ./capture/build.lock.json --staging-root "$(pwd -P)/staging"
```

If the command reports `OUTPUT_BUSY`, retry after the active publisher finishes. Use the same filename and inputs for an exact retry. An exit status of 1 reports the primary error first. If cleanup fails after publication, use an exact retry to check the published lock.

[Russian translation](../ru/how-to/lock-capture.md)

The capture directory MUST contain at most 4,096 direct entries, including any existing lock. A new lock needs one free entry.
