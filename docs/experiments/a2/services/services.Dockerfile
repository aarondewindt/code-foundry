ARG A2_WORKER_BASE
ARG A2_DATABASE_BASE
FROM ${A2_WORKER_BASE} AS worker
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
USER node

FROM ${A2_DATABASE_BASE} AS database
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends pgbouncer \
    && rm -rf /var/lib/apt/lists/*
USER postgres
ENTRYPOINT ["python3", "/probes/database_service.py"]
