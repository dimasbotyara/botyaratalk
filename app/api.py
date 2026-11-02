"""REST API: комнаты, история сообщений, локализация, health, настройки."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request

from .auth import current_user
from .i18n import get_translations, normalize_lang, resolve_lang
from .models import Message, Room

api_bp = Blueprint("api", __name__, url_prefix="/api")


def _unauthorized():
    return jsonify(ok=False, error="unauthorized"), 401


@api_bp.get("/health")
def health():
    return jsonify(ok=True, service="botyaratalk")


@api_bp.get("/i18n")
def i18n():
    """Переводы для текущего языка. Кешируется браузером на минуту."""
    lang = normalize_lang(request.args.get("lang")) if request.args.get("lang") else resolve_lang()
    resp = jsonify(ok=True, lang=lang, translations=get_translations(lang))
    resp.headers["Cache-Control"] = "public, max-age=60"
    return resp


@api_bp.get("/config")
def config():
    """Публичная конфигурация для фронтенда (ICE-серверы, лимиты)."""
    return jsonify(
        ok=True,
        ice_servers=current_app.config["ICE_SERVERS"],
        themes=list(current_app.config["THEMES"]),
        default_theme=current_app.config["DEFAULT_THEME"],
        langs=list(current_app.config["SUPPORTED_LANGS"]),
        default_lang=current_app.config["DEFAULT_LANG"],
        history_limit=current_app.config["HISTORY_LIMIT"],
        message_max_len=current_app.config["MESSAGE_MAX_LEN"],
    )


@api_bp.get("/rooms")
def rooms():
    if not current_user():
        return _unauthorized()
    items = Room.query.order_by(Room.position.asc(), Room.id.asc()).all()
    return jsonify(ok=True, rooms=[room.to_public() for room in items])


@api_bp.get("/rooms/<slug>/messages")
def messages(slug: str):
    if not current_user():
        return _unauthorized()

    room = Room.query.filter_by(slug=slug).first()
    if not room:
        return jsonify(ok=False, error="room_not_found"), 404

    try:
        limit = int(request.args.get("limit", current_app.config["HISTORY_LIMIT"]))
    except (TypeError, ValueError):
        limit = current_app.config["HISTORY_LIMIT"]
    limit = max(1, min(limit, 500))

    # Берём последние N и разворачиваем — на клиенте обычный хронологический
    # порядок «сверху вниз».
    rows = (
        Message.query.filter_by(room_id=room.id)
        .order_by(Message.id.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return jsonify(ok=True, room=room.to_public(), messages=[m.to_public() for m in rows])
