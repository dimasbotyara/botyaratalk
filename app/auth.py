"""Аутентификация: регистрация, логин, логаут, сессии.

Используем flask.session (подписанная cookie), без Flask-Login — так проще
и меньше зависимостей. Пароли — pbkdf2:sha256 через werkzeug.
"""

from __future__ import annotations

import re
import time
from collections import defaultdict

from flask import Blueprint, current_app, jsonify, request, session

from .i18n import get_translations, resolve_lang
from .models import User, db, utcnow

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

USERNAME_RE = re.compile(r"^[\w.\-]{3,32}$", re.UNICODE)
MIN_PASSWORD_LEN = 6

# Примитивная защита от перебора: N неудач с одного IP за окно времени.
_FAIL_WINDOW = 300.0
_FAIL_LIMIT = 20
_failures: dict[str, list[float]] = defaultdict(list)


def _msg(key: str, lang: str, **params) -> str:
    """Локализованное сообщение об ошибке — фронт показывает его как есть."""
    text = get_translations(lang).get(key, key)
    for name, value in params.items():
        text = text.replace("{" + name + "}", str(value))
    return text


def _client_ip() -> str:
    return request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()


def _too_many_failures() -> bool:
    now = time.time()
    bucket = [t for t in _failures[_client_ip()] if now - t < _FAIL_WINDOW]
    _failures[_client_ip()] = bucket
    return len(bucket) >= _FAIL_LIMIT


def _register_failure() -> None:
    _failures[_client_ip()].append(time.time())


def login_user(user: User) -> None:
    """Устанавливает сессию и обновляет last_seen."""
    session.clear()
    session["user_id"] = user.id
    session["username"] = user.username
    session.permanent = True
    user.last_seen = utcnow()
    db.session.commit()


def logout_user() -> None:
    session.clear()


def current_user() -> User | None:
    """Текущий пользователь или None (без падений на удалённых аккаунтах)."""
    user_id = session.get("user_id")
    if not user_id:
        return None
    return db.session.get(User, user_id)


def _payload() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@auth_bp.post("/register")
def register():
    lang = resolve_lang()
    data = _payload()
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    password2 = str(data.get("password2", password if "password2" not in data else ""))

    if not USERNAME_RE.match(username):
        return jsonify(ok=False, error=_msg("auth.err_username", lang)), 400
    if len(password) < MIN_PASSWORD_LEN:
        return jsonify(ok=False, error=_msg("auth.err_password_short", lang, min=MIN_PASSWORD_LEN)), 400
    if password != password2:
        return jsonify(ok=False, error=_msg("auth.err_password_mismatch", lang)), 400
    if User.query.filter_by(username_lower=username.lower()).first():
        return jsonify(ok=False, error=_msg("auth.err_username_taken", lang)), 409

    user = User(username=username, username_lower=username.lower())
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    login_user(user)
    return jsonify(ok=True, user=user.to_public()), 201


@auth_bp.post("/login")
def login():
    lang = resolve_lang()
    if _too_many_failures():
        return jsonify(ok=False, error=_msg("auth.err_rate_limited", lang)), 429

    data = _payload()
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    user = User.query.filter_by(username_lower=username.lower()).first()
    if not user or not user.check_password(password):
        _register_failure()
        return jsonify(ok=False, error=_msg("auth.err_credentials", lang)), 401

    login_user(user)
    return jsonify(ok=True, user=user.to_public())


@auth_bp.post("/logout")
def logout():
    logout_user()
    return jsonify(ok=True)


@auth_bp.get("/me")
def me():
    user = current_user()
    if not user:
        return jsonify(ok=False, user=None, error="unauthorized"), 401
    return jsonify(ok=True, user=user.to_public())


@auth_bp.get("/ice")
def ice():
    """ICE-конфиг для WebRTC (STUN; TURN в LAN не нужен)."""
    if not current_user():
        return jsonify(ok=False), 401
    return jsonify(ok=True, ice_servers=current_app.config["ICE_SERVERS"])
