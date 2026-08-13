FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY build.py serve.py ./
COPY ui ./ui
COPY jars ./jars
COPY videos ./videos
# Keep empty asset/out trees so mounts and local paths resolve.
COPY assets ./assets
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p out .cache \
  && chmod +x docker-entrypoint.sh

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["./docker-entrypoint.sh"]
