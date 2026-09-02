# Test Sandbox APT Mirror Design

## Goal

Make package installation in the `openclaw-test-node:22-slim` sandbox build use the Tencent Cloud Debian mirror, avoiding direct package downloads from `deb.debian.org` on the Tencent Cloud host.

## Scope

- Modify only `deploy/sandbox/Dockerfile.test-node`.
- Retain the Docker base image (`node:22-bookworm-slim`), installed packages, user setup, and sandbox security settings.
- Do not alter host Docker daemon configuration or the project's Agent package configuration.

## Design

Immediately before `apt-get update`, the Dockerfile will replace the Debian repository host in `/etc/apt/sources.list.d/debian.sources` from `deb.debian.org` to `mirrors.cloud.tencent.com`. This updates both the normal Debian and Debian security repositories supplied by the current `node:22-bookworm-slim` base image.

The existing package-install layer then uses the Tencent Cloud mirror without introducing new build arguments or runtime configuration.

## Verification

1. Rebuild `openclaw-test-node:22-slim` from `deploy/sandbox/Dockerfile.test-node`.
2. Confirm the build log fetches Debian packages from `mirrors.cloud.tencent.com`.
3. Run `docker run --rm openclaw-test-node:22-slim node --version`.

## Failure Handling

If the Tencent Cloud mirror cannot be reached or does not serve the required Bookworm repository, the build fails at `apt-get update` with its standard error. The single Dockerfile replacement can then be reverted to restore the upstream Debian source.
