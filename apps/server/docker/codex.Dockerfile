# The Codex CLI in a box. Agent Hub runs every Codex turn in a container from this image, with only
# that task's worktree mounted, so the container is the sandbox (see bin/codex-docker).
FROM node:22-bookworm-slim

# What an agent typically reaches for while working on a repo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 python3-venv curl procps less \
 && rm -rf /var/lib/apt/lists/*

# Must match the version the Codex SDK speaks to (its @openai/codex dependency); the server passes it.
ARG CODEX_VERSION
RUN npm install -g "@openai/codex@${CODEX_VERSION}" && codex --version

# mise, Node and pnpm preinstalled. Without them every task spent minutes downloading mise and the
# toolchain inside its throwaway container before it could run a single test. Tools live in
# /opt/mise, readable by the unprivileged uid the container runs as (HOME is /tmp at run time). The
# container is the sandbox, so every mise config in it is trusted. A repo asking for other versions
# still works: mise installs them at run time, only slower.
# Two things here are load-bearing. The global config lives in /opt/mise, not in root's home: at run
# time HOME is /tmp, and a shim with no version set fails outright ("No version is set for shim"),
# which broke every turn whose directory has no mise.toml (chat, video). And this block comes AFTER
# the Codex install, so `codex` is the base image's /usr/local/bin/codex, never a mise shim.
ARG MISE_VERSION=2026.8.11
ENV MISE_DATA_DIR=/opt/mise MISE_CACHE_DIR=/tmp/mise-cache MISE_GLOBAL_CONFIG_FILE=/opt/mise/config.toml \
    MISE_TRUSTED_CONFIG_PATHS=/ MISE_YES=1 \
    PATH=/opt/mise/shims:$PATH
RUN arch="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
 && curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${arch}" -o /usr/local/bin/mise \
 && chmod +x /usr/local/bin/mise \
 && mise install node@22 pnpm@10 && mise use -g node@22 pnpm@10 && mise reshim \
 && chmod -R a+rX /opt/mise && mise --version
