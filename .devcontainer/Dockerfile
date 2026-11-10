FROM node:26-bookworm

ENV COREPACK_HOME=/opt/corepack
ARG OPENCODE_VERSION=1.19.5

# Native addons (including SQLite bindings) need Python, make and C++.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl gh git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global corepack@0.36.0 opencode-ai@${OPENCODE_VERSION} \
    && corepack enable \
    && corepack install --global yarn@4.18.1

# Seed named-volume ownership for the non-root development user.
RUN mkdir -p /home/node/.cache/yarn /home/node/.cache/node-gyp \
    && chown -R node:node /home/node/.cache

USER node
