"""HTML-роуты: онбординг, авторизация, приложение, настройки."""

from __future__ import annotations

from flask import (
    Blueprint,
    current_app,
    make_response,
    redirect,
    render_template,
    request,
    url_for,
)

from .auth import current_user
from .i18n import get_translations, resolve_lang, resolve_theme

routes_bp = Blueprint("pages", __name__)


def _is_onboarded() -> bool:
    return request.cookies.get(current_app.config["ONBOARD_COOKIE"]) == "1"


def _render(page: str, **extra):
    """Общий контекст шаблонов: язык, тема, переводы, списки тем."""
    lang = resolve_lang()
    theme = resolve_theme()
    user = current_user()
    context = {
        "lang": lang,
        "theme": theme,
        "themes": current_app.config["THEMES"],
        "default_theme": current_app.config["DEFAULT_THEME"],
        "translations": get_translations(lang),
        "user": user.to_public() if user else None,
        "onboarded": _is_onboarded(),
        "ice_servers": current_app.config["ICE_SERVERS"],
        "history_limit": current_app.config["HISTORY_LIMIT"],
        "app_name": "botyaratalk",
    }
    context.update(extra)
    return render_template(page, **context)


@routes_bp.get("/")
def index():
    if current_user():
        return redirect(url_for("pages.app_page"))
    if not _is_onboarded():
        return redirect(url_for("pages.onboarding"))
    return redirect(url_for("pages.auth_page"))


@routes_bp.get("/onboarding")
def onboarding():
    # Уже залогинен — онбординг не нужен
    if current_user():
        return redirect(url_for("pages.app_page"))
    resp = make_response(_render("onboarding.html"))
    if not _is_onboarded():
        # Первый визит: запоминаем язык по Accept-Language, чтобы визард
        # открылся на «правильном» языке (пользователь может его сменить).
        resp.set_cookie(
            current_app.config["LANG_COOKIE"],
            resolve_lang(),
            max_age=60 * 60 * 24 * 365,
            samesite="Lax",
        )
    return resp


@routes_bp.get("/auth")
def auth_page():
    if current_user():
        return redirect(url_for("pages.app_page"))
    if not _is_onboarded():
        return redirect(url_for("pages.onboarding"))
    return _render("auth.html")


@routes_bp.get("/app")
def app_page():
    # Порядок важен: сначала онбординг, потом авторизация — так первый визит
    # ведёт прямо в визард, а не через промежуточный редирект на /auth.
    if not _is_onboarded():
        return redirect(url_for("pages.onboarding"))
    if not current_user():
        return redirect(url_for("pages.auth_page"))
    return _render("app.html")


@routes_bp.get("/settings")
def settings_page():
    if not _is_onboarded():
        return redirect(url_for("pages.onboarding"))
    if not current_user():
        return redirect(url_for("pages.auth_page"))
    return _render("app.html", open_settings=True)


@routes_bp.get("/favicon.ico")
def favicon():
    return redirect(url_for("static", filename="img/favicon.svg"))
