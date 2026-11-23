FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" \
    ENGINE_PROVIDER_DECLARATIONS="/app/provider-declarations" \
    ENGINE_HOST=0.0.0.0

WORKDIR /app
RUN python -m pip install --no-cache-dir "uv==0.13.4"
COPY apps/engine/pyproject.toml apps/engine/uv.lock ./
COPY apps/engine/src ./src
COPY apps/db/config/providers/*.yaml ./provider-declarations/
COPY apps/db/config/providers/default-city.txt ./provider-declarations/
RUN uv sync --locked --no-dev --no-editable --extra r2 \
    && adduser --disabled-password --gecos "" appuser

USER appuser
RUN --network=none /app/.venv/bin/python -m transit_engine.install_httpfs

EXPOSE 8080
CMD ["transit-engine"]
