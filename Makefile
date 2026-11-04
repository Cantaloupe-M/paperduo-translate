.PHONY: setup dev up down test test-py test-web

PY := .venv/bin/python

setup:  ## 创建虚拟环境并安装依赖
	python3 -m venv .venv
	.venv/bin/pip install -r requirements.txt

dev:  ## 本地运行后端（需先 docker compose up -d grobid）
	$(PY) -m uvicorn paperduo.server:app --host 127.0.0.1 --port 4174 --reload

up:  ## 通过 Docker Compose 启动
	docker compose -p paperduo up -d --build

down:
	docker compose -p paperduo down

test: test-py test-web

test-py:
	$(PY) -m unittest discover -s tests/python -v

test-web:
	node --test tests/web/*.test.mjs
