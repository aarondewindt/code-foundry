# Candidate only: the caller verifies the local base alias against the reviewed ID.
ARG CF_WORKER_BASE
FROM ${CF_WORKER_BASE}
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
USER node
