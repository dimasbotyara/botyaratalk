# botyaratalk — короткие команды для рутинных действий
PY ?= python3

.PHONY: help install install-dev run test e2e lint screenshots seed clean

help:
	@echo "make install      — установить зависимости"
	@echo "make run          — запустить сервер на 0.0.0.0:5000"
	@echo "make test         — pytest"
	@echo "make e2e          — сквозной тест WebRTC (два браузера)"
	@echo "make lint         — ruff"
	@echo "make screenshots  — снять 15 скриншотов Playwright"
	@echo "make seed         — создать/проверить комнаты"
	@echo "make clean        — удалить базу и скриншоты"

install:
	$(PY) -m pip install -r requirements.txt

install-dev:
	$(PY) -m pip install -r requirements-dev.txt
	$(PY) -m playwright install chromium

run:
	$(PY) run.py

test:
	$(PY) -m pytest tests/ -q

e2e:
	$(PY) tests/e2e_two_peers.py

lint:
	$(PY) -m ruff check .

screenshots:
	$(PY) scripts/take_screenshots.py

seed:
	$(PY) scripts/seed_rooms.py

clean:
	rm -f instance/botyaratalk.db
	rm -rf screenshots
	@echo "база и скриншоты удалены"
