"""Конфигурация приложения botyaratalk.

Все "магические" значения собраны здесь, чтобы остальные модули не знали
о путях и флагах напрямую.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

# --- Пути ---------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
INSTANCE_DIR = BASE_DIR / "instance"
LOCALES_DIR = BASE_DIR / "locales"
SCREENSHOTS_DIR = BASE_DIR / "screenshots"


def _load_secret_key() -> str:
    """SECRET_KEY: из переменной окружения либо из instance/secret.key.

    Файл генерируется при первом запуске и переиспользуется дальше, иначе
    сессии и cookie слетали бы при каждом рестарте.
    """
    env_key = os.environ.get("BOTYARATALK_SECRET_KEY")
    if env_key:
        return env_key

    INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    key_file = INSTANCE_DIR / "secret.key"
    if key_file.exists():
        value = key_file.read_text(encoding="utf-8").strip()
        if value:
            return value

    value = secrets.token_hex(32)
    key_file.write_text(value, encoding="utf-8")
    try:  # на Windows/некоторых ФС chmod может быть недоступен — не падаем
        os.chmod(key_file, 0o600)
    except OSError:
        pass
    return value


# Список тем — единый источник правды для шаблонов и API.
THEMES = (
    "catppuccin-latte",
    "catppuccin-frappe",
    "catppuccin-macchiato",
    "catppuccin-mocha",
    "ayu-light",
    "ayu-dark",
    "ayu-mirage",
    "gruvbox-light",
    "gruvbox-dark",
    "gruvbox-material",
)

SUPPORTED_LANGS = ("en", "ru")


class Config:
    """Базовая конфигурация (используется и в проде, и в тестах)."""

    # Flask
    SECRET_KEY = _load_secret_key()
    SESSION_COOKIE_NAME = "botyaratalk_session"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = False  # LAN работает по http, см. README
    PERMANENT_SESSION_LIFETIME = 60 * 60 * 24 * 30  # 30 дней

    # База данных
    # Путь к БД строится через pathlib и затем переводится в «posix»-форму:
    # так URI одинаково корректен и на Windows (C:\...), и на POSIX.
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "BOTYARATALK_DB",
        "sqlite:///" + (INSTANCE_DIR / "botyaratalk.db").as_posix(),
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}

    # Локализация / темы
    DEFAULT_LANG = "en"
    SUPPORTED_LANGS = SUPPORTED_LANGS
    THEMES = THEMES
    DEFAULT_THEME = "catppuccin-mocha"
    LANG_COOKIE = "botyaratalk_lang"
    THEME_COOKIE = "botyaratalk_theme"
    ONBOARD_COOKIE = "botyaratalk_onboarded"

    # Socket.IO: gevent в проде (см. run.py), threading в тестах
    ASYNC_MODE = os.environ.get("BOTYARATALK_ASYNC_MODE", "gevent")
    # Папка для локалей — абсолютный путь, не зависящий от cwd
    LOCALES_DIR = str(LOCALES_DIR)
    SOCKETIO_CORS_ORIGINS = os.environ.get("BOTYARATALK_CORS", "*")

    # WebRTC: TURN не настраиваем — проект про LAN
    ICE_SERVERS = [
        {"urls": ["stun:stun.l.google.com:19302"]},
    ]

    # Ограничения чата
    MESSAGE_MAX_LEN = 2000
    HISTORY_LIMIT = 100
    MESSAGE_RATE_LIMIT = (5, 2.0)  # не более 5 сообщений за 2 секунды

    # Скрипт seed-комнат
    # Три «общих канала». name_key — ключ локализации названия комнаты,
    # text_key / voice_key — подписи каналов внутри категорий сайдбара.
    SEED_ROOMS = (
        {
            "slug": "channel-1",
            "name_key": "room.channel_1",
            "text_key": "channel.text_1",
            "voice_key": "channel.voice_1",
            "position": 0,
        },
        {
            "slug": "channel-2",
            "name_key": "room.channel_2",
            "text_key": "channel.text_2",
            "voice_key": "channel.voice_2",
            "position": 1,
        },
        {
            "slug": "channel-3",
            "name_key": "room.channel_3",
            "text_key": "channel.text_3",
            "voice_key": "channel.voice_3",
            "position": 2,
        },
    )


class TestConfig(Config):
    """Конфиг для pytest: in-memory SQLite, threading-режим Socket.IO."""

    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    ASYNC_MODE = "threading"
    SECRET_KEY = "test-secret-key"
    WTF_CSRF_ENABLED = False
    MESSAGE_RATE_LIMIT = (100, 1.0)
