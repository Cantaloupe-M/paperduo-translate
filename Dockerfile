FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    READER_DATA_DIR=/data

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY paperduo/ ./paperduo/
COPY web/ ./web/

EXPOSE 4174
CMD ["python", "-m", "uvicorn", "paperduo.server:app", "--host", "0.0.0.0", "--port", "4174"]
