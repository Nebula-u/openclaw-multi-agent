# Test Sandbox Tencent APT Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Debian package downloads during the test sandbox image build through Tencent Cloud's mirror.

**Architecture:** Add one repository-host rewrite to the sandbox Dockerfile immediately before the existing package-install command. The base image, package list, sandbox user, filesystem layout, and Docker daemon configuration remain unchanged. A full Docker build and a container execution check prove the changed build path and resulting image.

**Tech Stack:** Docker Buildx, `node:22-bookworm-slim`, Debian APT, Tencent Cloud Debian mirror.

## Global Constraints

- Modify only `deploy/sandbox/Dockerfile.test-node` for the runtime behavior.
- Replace `deb.debian.org` with `mirrors.cloud.tencent.com` in `/etc/apt/sources.list.d/debian.sources` before `apt-get update`.
- Preserve the existing installed packages and sandbox hardening commands exactly.
- Do not change Docker daemon configuration or Agent package configuration.

---

### Task 1: Use Tencent Cloud's Debian mirror in the sandbox build

**Files:**
- Modify: `deploy/sandbox/Dockerfile.test-node:5`
- Test: Docker build log and `docker run` invocation

**Interfaces:**
- Consumes: the upstream `node:22-bookworm-slim` image's `/etc/apt/sources.list.d/debian.sources` repository declaration.
- Produces: an `openclaw-test-node:22-slim` image whose APT package downloads use `mirrors.cloud.tencent.com`.

- [x] **Step 1: Establish the failing reproduction**

Run:

```bash
docker build --no-cache --progress=plain --tag openclaw-test-node:22-slim --file deploy/sandbox/Dockerfile.test-node .
```

Expected before the change: APT download lines identify `deb.debian.org/debian`.

- [x] **Step 2: Implement the repository rewrite**

Change the start of the existing `RUN` instruction to:

```dockerfile
RUN sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
```

Keep every following command in the existing `RUN` instruction unchanged.

- [x] **Step 3: Rebuild and verify the changed package source**

Run:

```bash
docker build --no-cache --progress=plain --tag openclaw-test-node:22-slim --file deploy/sandbox/Dockerfile.test-node .
```

Expected: the build exits with status 0 and package-download lines identify `mirrors.cloud.tencent.com/debian`.

- [x] **Step 4: Verify the image runs as expected**

Run:

```bash
docker run --rm openclaw-test-node:22-slim node --version
```

Expected: exit status 0 and a Node.js 22 version.

- [x] **Step 5: Commit**

```bash
git add deploy/sandbox/Dockerfile.test-node docs/superpowers/plans/2026-08-21-test-sandbox-tencent-apt-mirror.md
git commit -m "build: use Tencent mirror for sandbox APT"
```
