# Image for running garmin-mcp over Streamable HTTP (used by Cloudflare Containers).
# Cloudflare Containers run linux/amd64; wrangler builds this file on `wrangler deploy`.
FROM python:3.12-slim

RUN pip install --no-cache-dir uv==0.9.0

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first so code changes don't invalidate this layer.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev

RUN useradd --create-home --uid 10001 app
USER app

EXPOSE 8080
CMD ["/app/.venv/bin/garmin-mcp-http", "--host", "0.0.0.0", "--port", "8080"]
