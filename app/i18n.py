"""Локализация: загрузка JSON-переводов и выбор языка."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from flask import current_app, has_request_context, request

# Порядок важен: первый язык — фолбэк для недостающих ключей.
FALLBACK_LANG = "en"


@lru_cache(maxsize=32)
def _load_locale_file(path: str, mtime: float) -> dict:
    """Читает JSON. mtime в сигнатуре — чтобы правки подхватывались без рестарта."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_locale(lang: str) -> dict:
    """Возвращает словарь переводов; при отсутствии файла — пустой словарь."""
    lang = normalize_lang(lang)
    path = Path(current_app.config["LOCALES_DIR"]) / f"{lang}.json"
    if not path.exists():
        return {}
    return _load_locale_file(str(path), path.stat().st_mtime)


def get_translations(lang: str) -> dict:
    """Переводы с фолбэком на английский для пропущенных ключей."""
    base = load_locale(FALLBACK_LANG) if normalize_lang(lang) != FALLBACK_LANG else {}
    merged = dict(base)
    merged.update(load_locale(lang))
    return merged


def normalize_lang(value: str | None) -> str:
    """``ru-RU`` → ``ru``; всё незнакомое → дефолтный язык приложения."""
    supported = current_app.config["SUPPORTED_LANGS"] if _has_app() else ("en", "ru")
    if not value:
        return current_app.config.get("DEFAULT_LANG", FALLBACK_LANG) if _has_app() else FALLBACK_LANG
    short = value.split(",")[0].split(";")[0].strip().lower().replace("_", "-")[:2]
    return short if short in supported else (current_app.config.get("DEFAULT_LANG", FALLBACK_LANG) if _has_app() else FALLBACK_LANG)


def _has_app() -> bool:
    try:
        from flask import current_app as _app

        return _app and not _app.config.get("PROPAGATE_EXCEPTIONS", False) is None
    except Exception:  # pragma: no cover - вне app context
        return False


def parse_accept_language(header: str | None) -> str | None:
    """Простенький парсер ``Accept-Language``: берём язык с максимальным q."""
    if not header:
        return None
    entries: list[tuple[float, str]] = []
    for chunk in header.split(","):
        parts = chunk.strip().split(";")
        tag = parts[0].strip()
        if not tag or tag == "*":
            continue
        q = 1.0
        for param in parts[1:]:
            param = param.strip()
            if param.startswith("q="):
                try:
                    q = float(param[2:])
                except ValueError:
                    q = 0.0
        entries.append((q, tag))
    entries.sort(key=lambda item: item[0], reverse=True)
    return entries[0][1] if entries else None


def resolve_lang(explicit: str | None = None) -> str:
    """Приоритет: явный аргумент → cookie → Accept-Language → дефолт."""
    if explicit:
        return normalize_lang(explicit)
    if has_request_context():
        cookie_lang = request.cookies.get(current_app.config["LANG_COOKIE"])
        if cookie_lang:
            return normalize_lang(cookie_lang)
        header_lang = parse_accept_language(request.headers.get("Accept-Language"))
        if header_lang:
            return normalize_lang(header_lang)
    return current_app.config["DEFAULT_LANG"]


def resolve_theme(explicit: str | None = None) -> str:
    """Тема: явный аргумент → cookie → дефолт из конфига."""
    themes = current_app.config["THEMES"]
    default = current_app.config["DEFAULT_THEME"]
    if explicit and explicit in themes:
        return explicit
    if has_request_context():
        cookie_theme = request.cookies.get(current_app.config["THEME_COOKIE"])
        if cookie_theme in themes:
            return cookie_theme
    return default
