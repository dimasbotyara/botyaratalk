#!/usr/bin/env python3
"""Точка входа botyaratalk.

Запускает Flask-SocketIO на 0.0.0.0:5000. По умолчанию используется gevent
(флаг BOTYARATALK_ASYNC_MODE=threading переключает на стандартные потоки —
это нужно тестам и отладке).
"""

from __future__ import annotations

import os
import subprocess
import sys

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

app = create_app()


def ensure_ssl_certs(host_ip: str) -> tuple[str, str]:
    """Создает самоподписанные сертификаты, если их нет в папке проекта."""
    cert_file = "cert.pem"
    key_file = "key.pem"

    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        print(f"🔐 Сертификаты не найдены. Генерирую новые для {host_ip}...")
        try:
            # Используем openssl через subprocess (есть в CachyOS/Linux из коробки)
            subprocess.run(
                [
                    "openssl", "req", "-x509", "-newkey", "rsa:4096",
                    "-keyout", key_file,
                    "-out", cert_file,
                    "-days", "365",
                    "-nodes",
                    "-subj", f"/CN={host_ip}",
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            print("✅ Сертификаты успешно созданы.")
        except FileNotFoundError:
            print("❌ Ошибка: утилита 'openssl' не найдена в системе.")
            print("Установите её (sudo pacman -S openssl) или создайте файлы cert.pem и key.pem вручную.")
            sys.exit(1)
        except subprocess.CalledProcessError as e:
            print(f"❌ Ошибка при генерации сертификатов: {e}")
            sys.exit(1)

    return key_file, cert_file


if __name__ == "__main__":
    host = os.environ.get("BOTYARATALK_HOST", "0.0.0.0")
    port = int(os.environ.get("BOTYARATALK_PORT", "5000"))
    debug = os.environ.get("BOTYARATALK_DEBUG", "0") == "1"
    use_https = os.environ.get("BOTYARATALK_HTTPS", "0") == "1"

    ssl_kwargs = {}
    if use_https:
        # Если запускаемся с HTTPS, получаем пути к сертификатам
        # (функция сама сгенерирует их, если их нет)
        keyfile, certfile = ensure_ssl_certs("10.92.213.3")
        ssl_kwargs = {
            "keyfile": keyfile,
            "certfile": certfile,
        }

    protocol = "https" if use_https else "http"
    print(f"🚀 botyaratalk: запускаюсь на {protocol}://{host}:{port} (async_mode={ASYNC_MODE})")
    
    socketio.run(
        app,
        host=host,
        port=port,
        debug=debug,
        use_reloader=False,  # gevent + reloader = дубли процессов, не нужно
        allow_unsafe_werkzeug=True,  # локальный/LAN-сервер, не публичный прод
        **ssl_kwargs,  # Передаем keyfile и certfile (работает и для gevent, и для threading)
    )
