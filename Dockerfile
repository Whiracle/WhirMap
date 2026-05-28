# Whiracle WhirMap one-service runtime image.
# The React frontend is already prebuilt into frontend/dist,
# so Docker does NOT run npm install/npm build.
FROM python:3.12-slim AS runtime

WORKDIR /app

LABEL org.opencontainers.image.title="Whiracle WhirMap"
LABEL org.opencontainers.image.description="Self-hosted live network map for manual topology editing and ICMP status tracking"

RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/ /app/backend/
COPY frontend/dist /app/frontend/dist

ENV FRONTEND_DIST=/app/frontend/dist
ENV DB_PATH=/data/app.db
ENV PING_INTERVAL_SECONDS=5

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8080"]
