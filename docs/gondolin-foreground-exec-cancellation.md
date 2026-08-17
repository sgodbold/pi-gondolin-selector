# Gondolin foreground exec cancellation limitation

## Status

**Known limitation — intentionally not implemented in this repository.**

We investigated adding selector-side process cancellation and decided not to carry the required race-sensitive workaround unless this limitation causes recurring operational problems. We also do not plan to change Gondolin upstream.

This document records the behavior, impact, ownership, and the proposed selector-side fix in case the decision is revisited.

## Summary

When Pi aborts or times out a foreground Bash command routed through Gondolin, Pi stops waiting for the command but the command may continue running inside the guest VM.

The host-side Gondolin exec promise rejects and its output session is discarded, but Gondolin 0.12.0 does not signal the corresponding guest process. Pi therefore reports the tool call as aborted or timed out even though the shell or its descendants may still be executing.

In short, cancellation currently means **stop observing the guest command**, not necessarily **stop executing the guest command**.

## Affected execution path

The behavior originates in the normal Bash routing implemented by `createGondolinBashOps()` in `extensions/router.ts`.

That adapter:

1. receives Pi's `AbortSignal` and optional Bash timeout;
2. creates an internal `AbortController` so either condition can cancel the Gondolin exec;
3. passes the internal signal to `vm.exec()`;
4. translates the result back to Pi as `aborted` or `timeout:<seconds>`.

This preserves Pi's visible result semantics, but it relies on Gondolin to terminate the guest process when the signal is aborted.

## Confirmed Gondolin 0.12.0 behavior

In the distributed `@earendil-works/gondolin` 0.12.0 implementation, the abort listener in `VM.execInternal()`:

1. rejects the host `ExecSession` with `exec aborted`; and
2. removes the session from the host-side session map.

It does not send a cancellation or signal message to the guest. Removing the session abandons the guest process and its output rather than terminating it. The selector receives no guest PID or other process handle that it can subsequently kill.

This is an underlying Gondolin protocol limitation, but an upstream fix is out of scope by project decision.

## What is and is not affected

### Affected

- Pi's ordinary `bash` tool routed into the Gondolin VM.
- Interactive guest Bash routed through the same `createGondolinBashOps()` adapter.
- User aborts while a foreground guest command is running.
- Expiration of the Bash tool's `timeout` parameter.

### Not affected

- `host_bash` from the separate `pi-gondolin-host-exec` package. That extension captures Pi's local Bash backend and executes approved commands on the host; it does not use this repository's Gondolin exec adapter.
- Commands that complete before cancellation.
- Deliberately detached jobs after their start command has completed, such as jobs launched through `pi-async`. Any future fix must preserve this behavior.

## Impact and lifecycle boundary

An abandoned guest process can continue to:

- modify files in the read/write `/workspace` mount;
- run builds, tests, or deployment tooling;
- consume guest CPU and memory;
- hold guest locks or ports;
- run child or grandchild processes;
- produce output that Pi can no longer retrieve.

Killing only the initial shell would not be sufficient because commands commonly create subprocesses.

The process remains confined to the Gondolin VM and its configured resources. Closing the VM is the lifecycle boundary intended to reclaim guest work, so this limitation does not create a persistent host process. It can nevertheless have persistent effects through the writable workspace or any explicitly exposed external service.

If a cancelled command may be destructive, close Pi/the active VM rather than assuming the reported cancellation stopped it. Workspace changes should then be inspected normally.

## Why the workaround was not implemented

A selector-level workaround is possible, but it is not a small signal-forwarding change. A correct implementation must account for:

- process-group creation and signaling;
- availability and behavior of `setsid` in selected guest images;
- an abort arriving before the guest command writes its process identity;
- cancellation racing with natural exit;
- repeated cancellation;
- escalation from `SIGTERM` to `SIGKILL`;
- cleanup exec calls that must not inherit the already-aborted signal;
- safe construction and removal of per-exec state files;
- descendants rather than only the initial shell;
- intentionally detached `pi-async` jobs;
- VM shutdown while cleanup is in progress.

This would add permanent, protocol-level workaround machinery to a selector whose primary responsibility is image selection, provisioning, lifecycle, and tool routing. The repository currently has no VM-backed integration-test harness for these races. We chose not to add that complexity preemptively.

## Proposed selector-side fix if revisited

Because an upstream Gondolin change is not planned, the viable implementation would live in this repository, preferably as an isolated helper rather than inline complexity in `createGondolinBashOps()`.

For each foreground exec:

1. Generate a cryptographically unguessable execution identifier and guest state-file path.
2. Start a wrapper under `setsid` so the foreground command owns a distinct process group.
3. Have the wrapper write its PID/process-group ID to the state file before executing the user's shell command.
4. Continue passing Pi's abort/timeout signal to the primary `vm.exec()` so Pi retains its current visible cancellation behavior.
5. On cancellation, start a second `vm.exec()` that is not connected to the aborted signal.
6. Have that cleanup exec wait briefly for the state file to cover immediate-abort races.
7. Read and strictly validate the numeric process-group ID inside the guest; never interpolate the user's command into the cleanup shell.
8. Signal the negative process-group ID with `SIGTERM`.
9. After a bounded grace period, signal it with `SIGKILL` if the group still exists.
10. Remove the state file after normal completion or cancellation cleanup.

Cancellation must be idempotent. A missing process group after a natural exit should count as successful cleanup, not as a new tool failure. Cleanup errors must not replace Pi's original `aborted` or `timeout:<seconds>` result.

The wrapper must also define the detachment boundary carefully: once a command such as `pi-async start` has successfully returned, later foreground cleanup must not terminate the detached job.

## Required tests if revisited

A robust implementation should not be merged with unit tests alone. It needs VM-backed acceptance tests covering:

- abort a sleeping command that recorded its PID; verify the PID disappears;
- abort a shell with multiple children; verify the entire process group disappears;
- trigger the Bash timeout; verify the group disappears and Pi still reports a timeout;
- abort immediately during spawn;
- abort the same operation repeatedly;
- race cancellation against natural completion;
- verify normal exit codes and streamed output remain unchanged;
- start `pi-async start test -- sleep 30`; verify the detached job remains available after the start call completes;
- close the VM with foreground and detached work active; verify guest work is reclaimed;
- exercise cleanup after the state file or process group has already disappeared.

## Reconsideration criteria

Revisit the workaround if one or more of the following becomes true:

- cancelled commands repeatedly continue modifying workspaces;
- leaked guest processes materially affect long-running Pi sessions;
- a clean, stable cancellation API becomes available without an upstream protocol change;
- the repository gains a VM-backed integration-test harness capable of covering the required races.
