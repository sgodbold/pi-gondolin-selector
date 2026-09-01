<img width="1263" height="630" alt="image" src="https://github.com/user-attachments/assets/b8be3385-27f8-4f53-9ad8-2605bdb9c79c" />


# pi-gondolin-selector

A [Pi](https://pi.dev) extension that selects a locally tagged Gondolin image at startup, creates an ephemeral VM from it, and routes Pi's built-in tools into that VM.

By default, the host project is mounted read/write at `/workspace` and is also the guest working directory. A parent host workspace can instead be mounted while Pi and all guest tools start in a child project directory. The installed Pi package documentation is mounted read-only at `/opt/pi-coding-agent`. Other guest filesystem changes disappear when Pi exits.

## Requirements

- Node.js 23.6 or newer
- Locally tagged images in Gondolin's image store
- A Gondolin-supported hypervisor/runtime

Images are discovered through the public `@earendil-works/gondolin` API. The extension does not scan Gondolin's cache directory.

## Install or tag a Gondolin image

The selector lists tagged images, not arbitrary asset directories. After building an asset directory containing a valid `manifest.json`, import and tag it through Gondolin's public API:

```typescript
import {
  importImageFromDirectory,
  setImageRef,
} from "@earendil-works/gondolin";

const imported = importImageFromDirectory("/absolute/path/to/assets");
const ref = setImageRef("my-agent:latest", imported.buildId, imported.arch);
console.log(`Installed ${ref.reference}`);
```

The equivalent convenience API is:

```typescript
import { tagImage } from "@earendil-works/gondolin";

const ref = tagImage("/absolute/path/to/assets", "my-agent:latest");
console.log(`Installed ${ref.reference}`);
```

Do not manually copy images into or recursively scan Gondolin's cache. These APIs honor `GONDOLIN_IMAGE_STORE`; otherwise they use `${XDG_CACHE_HOME:-$HOME/.cache}/gondolin/images`.

Verify installed tags with:

```typescript
import { listImageRefs, resolveImageSelector } from "@earendil-works/gondolin";

for (const ref of listImageRefs()) {
  console.log(ref.reference, resolveImageSelector(ref.reference).assetDir);
}
```

## Install the Pi extension

From this checkout:

```bash
pi install /absolute/path/to/pi-gondolin-selector
```

Pi records the local path rather than copying it. Once installed globally, run Pi normally:

```bash
pi
```

Do not load a legacy Gondolin routing extension at the same time. Two routing extensions would both override Pi's built-in tools and could start separate VMs.

Use `pi config` to enable this package and migrate other repeated `-e` arguments into Pi's global package configuration.

## Configuration

The optional user configuration is:

```text
~/.pi/agent/gondolin-selector.json
```

(`PI_CODING_AGENT_DIR` changes the parent directory.) Copy the included example to preserve the current homelab and dbuild profiles:

```bash
cp examples/gondolin-selector.json ~/.pi/agent/gondolin-selector.json
```

Without configuration, all locally tagged images are shown and use the generic profile.

See [`examples/gondolin-selector.json`](examples/gondolin-selector.json) for a complete configuration.

### Top-level settings

- `imageFilter`: optional JavaScript regular expression. If omitted, all locally tagged images are shown. Newly tagged images matching this expression appear automatically.
- `rememberByProject`: remember selections by canonical project path; defaults to `true`.
- `profiles`: ordered declarative runtime profiles.

### Profiles

A profile combines:

```text
image match
+ network policy
+ required host resources
+ ephemeral provisioning
+ prompt guidance
```

Images requiring only the standard workspace, documentation mount, and environment isolation need no profile. Add a profile when an image needs special networking, host resources, guest files, or model guidance:

```json
{
  "name": "my-agent",
  "imagePattern": "my-agent:*",
  "network": {
    "dns": {
      "mode": "synthetic",
      "syntheticHostMapping": "per-host"
    },
    "tcpHosts": {
      "service:22": "service.example.com:22",
      "service.example.com:22": "service.example.com:22"
    }
  },
  "directories": [
    {
      "path": "/root/.ssh",
      "mode": "0700"
    }
  ],
  "files": [
    {
      "source": "~/.config/gondolin/my-agent/id_ed25519",
      "destination": "/root/.ssh/id_ed25519",
      "mode": "0600",
      "required": true
    },
    {
      "destination": "/etc/ssh/ssh_config.d/99-agent.conf",
      "mode": "0644",
      "content": "Host service service.example.com\n    IdentityFile /root/.ssh/id_ed25519\n"
    }
  ],
  "mounts": [
    {
      "source": "~/.config/my-application",
      "destination": "/host/config/my-application",
      "required": true
    }
  ],
  "promptGuidance": [
    "The service alias resolves to service.example.com."
  ]
}
```

Profile rules:

- `imagePattern` is a minimatch glob, unlike the regular-expression `imageFilter`.
- Profile names must be unique; they are used by `--gondolin-profile`.
- Profiles are evaluated in configuration order.
- Selecting an image that matches multiple profiles is an error.
- An image matching no profile uses the generic runtime behavior.
- Valid DNS modes are `open`, `trusted`, and `synthetic`.
- Valid synthetic host mappings are `single` and `per-host`.
- `network.tcpHosts` maps Gondolin aliases to canonical endpoints; it is passed as `tcp.hosts` without flattening.
- Do not grant unrestricted TCP egress unless the profile explicitly needs it.
- `directories` creates absolute guest paths and applies explicit three- or four-digit octal modes.
- Each `files` entry has exactly one of `source` (host file) or `content` (inline generated file).
- File destinations must be absolute guest paths.
- `~` expansion applies only to host `source` paths.
- Source files are required unless `required` is explicitly `false`.
- Required host files are validated before VM creation.
- Host files are copied into the ephemeral guest.
- `mounts` exposes a host directory live and read-only at an absolute guest destination; `~` expansion applies to its host source.
- Mount sources are required unless `required` is explicitly `false`. An absent optional source is skipped.
- Mount destinations must be normalized, unique, and non-overlapping. They cannot overlap `/workspace` or `/opt/pi-coding-agent`.
- Mount only narrowly scoped directories: all mounted contents are visible to the agent and may contain sensitive data.
- JSON strings must escape embedded newlines as `\n`.

Inline files make security-sensitive runtime configuration independent of image contents. The included homelab example provisions `/etc/ssh/ssh_config.d/99-agent.conf` this way.

### Adding a new image

1. Build, import, and tag the image.
2. Ensure its tag matches `imageFilter`, or update/remove the filter.
3. Add a profile only if it needs behavior beyond the generic runtime.
4. Restart Pi and select the new tag.
5. Run `/gondolin` to confirm the active image and mounts.
6. Verify permitted network destinations work and unpermitted destinations remain blocked.
7. Verify provisioned file modes without printing credential contents.

## Workspace mount root and project CWD

By default, Pi's host working directory is mounted at `/workspace`, and guest tools start there. For delegated worktrees, start Pi in the assigned worktree and pass the parent workspace separately:

```bash
cd /path/to/coordinator/grimoire/.worktrees/task-1/worker
pi --gondolin-workspace-root /path/to/coordinator
```

This produces:

```text
Host Pi CWD:       /path/to/coordinator/grimoire/.worktrees/task-1/worker
Host mount root:   /path/to/coordinator
Guest mount root:  /workspace
Guest initial CWD: /workspace/grimoire/.worktrees/task-1/worker
```

The workspace root defaults to Pi's host CWD for backward compatibility. It may be relative to Pi's host CWD, is canonicalized before use, and must contain that CWD. The selector rejects paths outside the mounted workspace and refuses to mount the host filesystem root.

During disposable VM provisioning, the selector adds only the computed guest project CWD as a Git `safe.directory` entry in `/root/.gitconfig`. It never changes host Git configuration or configures `safe.directory=*`.

When constructing child agent arguments, pass the workspace root alongside the explicit Gondolin profile:

```json
{
  "agentArgs": [
    "--gondolin-profile",
    "homelab",
    "--gondolin-workspace-root",
    "/path/to/coordinator"
  ]
}
```

Starting Pi in a worktree also makes that canonical worktree path the remembered-selection identity. Delegated noninteractive children should therefore use explicit profile/image arguments rather than relying on selection remembered for the workspace root.

## Explicit CLI selection

Use a configured profile name to bypass the startup menu:

```bash
pi --gondolin-profile homelab
```

If the profile matches multiple locally tagged images, select an exact image as well:

```bash
pi --gondolin-profile homelab --gondolin-image homelab-agent:dev
```

`--gondolin-profile` succeeds without `--gondolin-image` only when exactly one available image matches the profile. `--gondolin-image` requires `--gondolin-profile`, must name an image available through the selector, and must match that profile. Explicit CLI selections apply only to the current process and do not update remembered project state.

List configured profiles, matching local images, selection status, runtime settings, and host-resource availability without starting a VM:

```bash
pi --list-gondolin-profiles
```

This is useful when constructing child agent arguments:

```json
{
  "agentArgs": [
    "--exclude-tools",
    "herdr_layout,herdr_pane,herdr_agent",
    "--gondolin-profile",
    "homelab",
    "--gondolin-workspace-root",
    "/path/to/coordinator"
  ]
}
```

## Remembered selection

State is stored separately at:

```text
~/.pi/agent/gondolin-selector-state.json
```

Projects are keyed by canonical path. State updates are atomic and the file is set to mode `0600`.

The remembered image is placed first in the startup selector, but interactive startup still requires confirmation. Cancelling the startup selector exits Pi.

For noninteractive startup, the extension uses a valid remembered image. Select one interactively first if none is remembered.

## Inter-extension events

After resolving the active selection, the extension emits `gondolin-selector:selected` on Pi's shared event bus:

```typescript
pi.events.on("gondolin-selector:selected", (data) => {
  const selection = data as {
    profile: string | null;
    reference: string;
  };
  // Activate profile-specific coordination here.
});
```

`profile` is `null` when the image uses generic runtime behavior. Register the listener in the consuming extension's factory so it cannot miss the session-start event. The event means that selection and local image resolution succeeded; it does not mean that VM startup and provisioning have completed. Event handlers are not awaited by the emitter, and the event is intended for coordination rather than as an authentication boundary.

`/gondolin-select` does not emit this event because it only remembers a selection for the next Pi start.

## Commands

- `/gondolin` shows the active VM, image, mounts, and shell.
- `/gondolin-select` remembers a different image for the current project. Restart Pi to use it; the extension does not replace a live VM.

Interactive `!` and `!!` commands run inside Gondolin. Prefix a command with `host:` to run that one command on the host:

```text
!host: git status
```

## Environment isolation

Agent Bash and interactive Bash use the same allowlist. The extension retains:

- exact names: `TERM`, `COLORTERM`, `LANG`, `LC_ALL`, `LC_COLLATE`, `TZ`, `EDITOR`, `VISUAL`, `PAGER`;
- prefixes: `PI_`, `RTK_`, `GIT_`.

It then forces guest-canonical identity, shell, path, temporary, and XDG values. API tokens, `SSH_AUTH_SOCK`, desktop/session variables, and all other unlisted variables are dropped.

`GIT_*` is retained for compatibility and can contain sensitive Git configuration. The bare `GIT_CONFIG` variable and every inherited `GIT_CONFIG_*` variable are removed. Guest Bash then sets only `GIT_CONFIG_GLOBAL=/root/.gitconfig` so it reads the provisioned exact `safe.directory` entry.

## Known limitations

Aborting or timing out a foreground command can stop Pi's host-side exec session without terminating the command inside a Gondolin 0.12.0 guest. See [Gondolin foreground exec cancellation limitation](docs/gondolin-foreground-exec-cancellation.md) for impact, the decision not to add a selector-side workaround, and the proposed design if that decision is revisited.

## Development

```bash
npm install --ignore-scripts
npm test
npm run check
```
