"""REST API: комнаты, история сообщений, локализация, health, настройки."""

from __future__ import annotations

import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

from flask import Blueprint, current_app, jsonify, request

from .auth import current_user
from .avatar import (  # noqa: F401 (часть символов используется ниже)
    ALLOWED_SIGNATURES,
    MAX_UPLOAD_BYTES,
    PALETTES,
    is_png,
    normalize_density,
    normalize_palette,
    normalize_seed,
    random_seed,
    render_svg,
    validate_upload,
)
from .i18n import get_translations, normalize_lang, resolve_lang
from .links import is_safe_url, normalize_url
from .models import Message, Room, User, db

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
    previews = _reply_previews(rows)
    return jsonify(
        ok=True,
        room=room.to_public(),
        messages=[m.to_public(reply_previews=previews) for m in rows],
    )


def _reply_previews(messages: list[Message]) -> dict[int, dict]:
    """Цитаты для ответов: id → {id, username, text}.

    Один дополнительный запрос на всю страницу истории вместо N+1.
    """
    reply_ids = {m.reply_to_id for m in messages if m.reply_to_id}
    if not reply_ids:
        return {}

    sources = Message.query.filter(Message.id.in_(reply_ids)).all()
    return {
        item.id: {
            "id": item.id,
            "username": item.author.username if item.author else "?",
            "text": item.text[:180],
        }
        for item in sources
    }


# ------------------------------------------------------------------ аватарки
@api_bp.get("/avatar/generated.svg")
def avatar_generated():
    """Генеративная аватарка: детерминированный узор из сида.

    Отдаётся как SVG — масштабируется без потерь и весит меньше 20 КБ.
    """
    svg = render_svg(
        normalize_seed(request.args.get("seed")),
        normalize_palette(request.args.get("palette")),
        normalize_density(request.args.get("density")),
    )
    resp = current_app.response_class(svg, mimetype="image/svg+xml")
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


@api_bp.get("/avatar/<username>")
def avatar_file(username: str):
    """Загруженная аватарка пользователя из instance/avatars."""
    from flask import send_file

    user = User.query.filter_by(username_lower=username.lower()).first()
    if not user or user.avatar_kind != "upload" or not user.avatar_file:
        return jsonify(ok=False, error="not_found"), 404

    path = avatar_path(user.avatar_file)
    if not path.exists():
        return jsonify(ok=False, error="not_found"), 404
    return send_file(path, mimetype="image/png", max_age=300)


@api_bp.get("/avatar/options")
def avatar_options():
    """Палитры и границы плотности — для UI генератора."""
    return jsonify(
        ok=True,
        palettes=[{"id": key, "bg": value["bg"], "fg": value["fg"]} for key, value in PALETTES.items()],
        density={"min": 5, "max": 55, "default": 30},
        seed=random_seed(),
        max_upload_bytes=MAX_UPLOAD_BYTES,
    )


@api_bp.post("/avatar/upload")
def avatar_upload():
    """Принимает обрезанный квадрат 256×256 в PNG (или JPEG/WEBP).

    Клиент уже привёл картинку к квадрату через canvas — сервер лишь проверяет
    сигнатуру и размер, чтобы в instance/avatars не попало ничего лишнего.
    """
    user = current_user()
    if not user:
        return _unauthorized()

    upload = request.files.get("avatar")
    if upload is None:
        return jsonify(ok=False, error="no_file"), 400

    data = upload.read(MAX_UPLOAD_BYTES + 1)
    ok, error = validate_upload(data)
    if not ok:
        return jsonify(ok=False, error=error), 400

    record = user
    filename = f"{record.id}-{random_seed()}.png"
    avatar_path(filename).write_bytes(data)

    # Старый файл больше не нужен
    if record.avatar_file and record.avatar_file != filename:
        old = avatar_path(record.avatar_file)
        if old.exists():
            old.unlink()

    record.avatar_kind = "upload"
    record.avatar_file = filename
    record.avatar_seed = None
    record.avatar_palette = None
    record.avatar_density = None
    db.session.commit()

    return jsonify(ok=True, avatar=record.avatar_public())


@api_bp.post("/avatar/generated")
def avatar_generated_save():
    """Сохраняет выбранный пиксельный узор как аватарку пользователя."""
    user = current_user()
    if not user:
        return _unauthorized()

    payload = request.get_json(silent=True) or {}
    record = user
    record.avatar_kind = "generated"
    record.avatar_file = None
    record.avatar_seed = normalize_seed(payload.get("seed"))
    record.avatar_palette = normalize_palette(payload.get("palette"))
    record.avatar_density = normalize_density(payload.get("density"))

    # Удаляем старый загруженный файл
    if record.avatar_file:
        old = avatar_path(record.avatar_file)
        if old.exists():
            old.unlink()
    db.session.commit()

    return jsonify(ok=True, avatar=record.avatar_public())


@api_bp.delete("/avatar")
def avatar_reset():
    """Сбрасывает аватарку — интерфейс вернётся к инициалам."""
    user = current_user()
    if not user:
        return _unauthorized()

    record = user
    if record.avatar_file:
        old = avatar_path(record.avatar_file)
        if old.exists():
            old.unlink()

    record.avatar_kind = None
    record.avatar_file = None
    record.avatar_seed = None
    record.avatar_palette = None
    record.avatar_density = None
    db.session.commit()
    return jsonify(ok=True)


def avatar_path(filename: str):
    """Путь к файлу аватарки. Имя всегда наше — но подстрахуемся от «..»."""
    from pathlib import Path

    safe = Path(filename).name
    return Path(current_app.config["AVATAR_DIR"]) / safe


@api_bp.get("/link-preview")
def link_preview():
    """Метаданные страницы для превью ссылки в чате.

    Запрос делает сервер (у браузера не будет CORS), но только по http/https
    и только к тем адресам, что прошли общий валидатор. Локальные адреса
    запрещены: иначе эндпоинт превращается в SSRF-прокси внутрь сети.
    """
    if not current_user():
        return _unauthorized()

    raw = request.args.get("url", "")
    url = normalize_url(raw)
    if not url or not is_safe_url(url):
        return jsonify(ok=False, error="bad_url"), 400

    host = (urlparse(url).hostname or "").lower()
    if _is_private_host(host):
        # LAN-адреса открываются как обычные ссылки, но без превью
        return jsonify(ok=False, error="local_url"), 400

    try:
        title, description = _fetch_title(url)
    except Exception:  # noqa: BLE001 — сеть не должна ломать чат
        return jsonify(ok=False, error="fetch_failed"), 200

    if not title:
        return jsonify(ok=False, error="no_title"), 200

    return jsonify(ok=True, url=url, host=host, title=title, description=description)


def _is_private_host(host: str) -> bool:
    import ipaddress

    if host in {"localhost", ""}:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host.endswith((".local", ".lan", ".internal"))
    return address.is_private or address.is_loopback or address.is_link_local


_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_DESC_RE = re.compile(
    r'<meta[^>]+(?:name|property)=["\'](?:description|og:description)["\'][^>]+content=["\'](.*?)["\']',
    re.IGNORECASE | re.DOTALL,
)
_OG_TITLE_RE = re.compile(
    r'<meta[^>]+(?:name|property)=["\']og:title["\'][^>]+content=["\'](.*?)["\']',
    re.IGNORECASE | re.DOTALL,
)


def _fetch_title(url: str) -> tuple[str | None, str | None]:
    """Тянет <title> и description. Таймаут жёсткий: чат не должен зависать."""
    request_headers = {
        "User-Agent": "botyaratalk/1.0 (link preview)",
        "Accept": "text/html,application/xhtml+xml",
    }
    req = urllib.request.Request(url, headers=request_headers)  # noqa: S310 (схемы проверены выше)
    with urllib.request.urlopen(req, timeout=4) as response:  # noqa: S310
        content_type = response.headers.get("Content-Type", "")
        if "html" not in content_type.lower():
            return None, None
        raw = response.read(200_000)

    charset = "utf-8"
    match = re.search(r"charset=([\w-]+)", content_type)
    if match:
        charset = match.group(1)
    html = raw.decode(charset, errors="ignore")

    def clean(value: str) -> str:
        text = re.sub(r"<[^>]+>", "", value)
        return re.sub(r"\s+", " ", text).strip()[:200]

    og_title = _OG_TITLE_RE.search(html)
    title_match = _TITLE_RE.search(html)
    title = clean(og_title.group(1)) if og_title else None
    if not title and title_match:
        title = clean(title_match.group(1))

    desc_match = _DESC_RE.search(html)
    description = clean(desc_match.group(1)) if desc_match else None
    return title or None, description or None
