FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" \
    ENGINE_HOST=0.0.0.0

WORKDIR /app
RUN python -m pip install --no-cache-dir "uv==0.13.4"
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --locked --no-dev --no-editable \
    && adduser --disabled-password --gecos "" appuser

USER appuser
RUN /app/.venv/bin/python -c 'import duckdb; duckdb.connect(config={"custom_extension_repository": "https://extensions.duckdb.org"}).execute("INSTALL httpfs")'

EXPOSE 8080
CMD ["transit-engine"]
