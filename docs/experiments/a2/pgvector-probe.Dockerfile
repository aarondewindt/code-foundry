# Disposable synthetic database experiment only; never uses an existing cluster.
FROM pgvector/pgvector:0.8.7-pg18-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
ENV A2_PGBIN=/usr/lib/postgresql/18/bin A2_REQUIRE_PG18_VECTOR=1
USER postgres
# Override the upstream entrypoint: database-probe.py initializes a fresh /tmp cluster.
ENTRYPOINT ["python3", "/probe.py"]
