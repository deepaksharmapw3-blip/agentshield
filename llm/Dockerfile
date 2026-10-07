# LLM FastAPI Service Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r llm && useradd -r -g llm llm

# Copy requirements (if present) or install from inline
RUN pip install --no-cache-dir --upgrade pip setuptools

# Install Python dependencies
RUN pip install --no-cache-dir \
    fastapi==0.104.1 \
    uvicorn==0.24.0 \
    ollama==0.6.3 \
    pydantic==2.9.2 \
    pydantic-settings==2.1.0 \
    python-multipart==0.0.6

# Copy application code
COPY llm ./llm

# Create logs directory
RUN mkdir -p /app/logs && chown llm:llm /app/logs

# Switch to non-root user
USER llm

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${LLM_API_PORT:-8000}/health || exit 1

# Expose port
EXPOSE 8000

# Start application
CMD ["uvicorn", "llm.fastapi_server:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
