# The base tag and sorted mise tools are part of the content-addressed image tag.
ARG CODEX_IMAGE
FROM ${CODEX_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends make \
 && rm -rf /var/lib/apt/lists/*

# Inherit /opt/mise and MISE_GLOBAL_CONFIG_FILE from Codex, so shims also work with HOME=/tmp
# in directories without mise.toml. TOOLS is validated before it becomes a build argument.
ARG TOOLS
RUN if [ -n "$TOOLS" ]; then mise install $TOOLS && mise use -g $TOOLS; fi \
 && mise reshim \
 && chmod -R a+rX /opt/mise
