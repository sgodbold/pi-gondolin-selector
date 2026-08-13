<img width="1263" height="630" alt="image" src="https://github.com/user-attachments/assets/b8be3385-27f8-4f53-9ad8-2605bdb9c79c" />


# pi-gondolin-selector

A [Pi](https://pi.dev) extension that selects a locally tagged Gondolin image at startup, creates an ephemeral VM from it, and routes Pi's built-in tools into that VM.

The host project is mounted read/write at `/workspace`. The installed Pi package documentation is mounted read-only at `/opt/pi-coding-agent`. Other guest filesystem changes disappear when Pi exits.

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
  "promptGuidance": [
    "The service alias resolves to service.example.com."
  ]
}
```

Profile rules:

- `imagePattern` is a minimatch glob, unlike the regular-expression `imageFilter`.
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
- Host files are copied into the ephemeral guest; host credential directories are never mounted.
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

## Remembered selection

State is stored separately at:

```text
~/.pi/agent/gondolin-selector-state.json
```

Projects are keyed by canonical path. State updates are atomic and the file is set to mode `0600`.

The remembered image is placed first in the startup selector, but interactive startup still requires confirmation. Cancelling the startup selector exits Pi.

For noninteractive startup, the extension uses a valid remembered image. Select one interactively first if none is remembered.

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

`GIT_*` is retained for compatibility and can contain sensitive Git configuration. Tighten the source if stricter isolation is required.

## Development

```bash
npm install --ignore-scripts
npm test
npm run check
```
