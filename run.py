#!/usr/bin/env python3
"""Точка входа botyaratalk.

Запускает Flask-SocketIO на 0.0.0.0:14098. По умолчанию используется gevent
(флаг BOTYARATALK_ASYNC_MODE=threading переключает на стандартные потоки —
это нужно тестам и отладке).

HTTPS включается сам: для локальной сети сертификат создаётся в instance/
при первом запуске (см. app/tls.py). Отключить — BOTYARATALK_HTTPS=0.
"""

from __future__ import annotations

import os

# gevent нужно патчить ДО импорта flask/socketio, иначе блокирующие вызовы
# (SQLite, чтение файлов) застопорят весь event loop.
ASYNC_MODE = os.environ.get("BOTYARATALK_ASYNC_MODE", "gevent")
if ASYNC_MODE == "gevent":
    try:
        from gevent import monkey  # noqa: WPS433 (импорт по месту обязателен)

        monkey.patch_all()
    except ImportError:  # gevent не установлен — молча падаем в threading
        ASYNC_MODE = "threading"
        os.environ["BOTYARATALK_ASYNC_MODE"] = "threading"

from app import create_app, socketio  # noqa: E402  (после monkey.patch_all)
from app.tls import build_ssl_context, https_urls  # noqa: E402
from config import DEFAULT_PORT  # noqa: E402

app = create_app()


if __name__ == "__main__":
    host = os.environ.get("BOTYARATALK_HOST", "0.0.0.0")
    port = int(os.environ.get("BOTYARATALK_PORT", str(DEFAULT_PORT)))
    debug = os.environ.get("BOTYARATALK_DEBUG", "0") == "1"

    ssl_context = build_ssl_context()
    scheme = "https" if ssl_context else "http"

    print(f"botyaratalk: запускаюсь на {scheme}://{host}:{port} (async_mode={ASYNC_MODE})")
    if ssl_context:
        for url in https_urls(host, port):
            print(f"  → {url}")
        print("  (самоподписанный сертификат: браузер попросит подтвердить один раз)")

    # ssl_context передаём только когда HTTPS включён: gevent-сервер
    # не принимает None и падает на попытке обернуть сокет.
    ssl_kwargs = {"ssl_context": ssl_context} if ssl_context else {}

    socketio.run(
        app,
        host=host,
        port=port,
        debug=debug,
        use_reloader=False,  # gevent + reloader = дубли процессов, не нужно
        allow_unsafe_werkzeug=True,  # локальный/LAN-сервер, не публичный прод
        **ssl_kwargs,
    )
