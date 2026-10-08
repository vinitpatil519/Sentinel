# Backend image. Also used for the simulator service, which is why scripts/ and
# the simulation package are both present.
FROM python:3.12-slim
WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/sentinel ./sentinel
RUN pip install --no-cache-dir .
COPY scripts ./scripts
ENV PYTHONPATH=/app
EXPOSE 8010 3001
CMD ["uvicorn", "sentinel.main:app", "--host", "0.0.0.0", "--port", "8010"]
