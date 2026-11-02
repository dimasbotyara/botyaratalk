"""Фабрика приложения botyaratalk."""

from __future__ import annotations

from pathlib import Path

from flask import Flask, jsonify
from flask_socketio import SocketIO

from config import Config

from . import api, auth, routes, sockets
from . import db as db_module

# SocketIO создаётся один раз на процесс и переиспользуется в run.py и тестах.
socketio = SocketIO(cors_allowed_origins="*", logger=False, engineio_logger=False)


def create_app(config_object=None) -> Flask:
    """Собирает приложение: конфиг, БД, blueprint'ы, socket-обработчики."""
    app = Flask(
        __name__,
        static_folder=str(Path(__file__).resolve().parent.parent / "static"),
        template_folder=str(Path(__file__).resolve().parent.parent / "templates"),
    )

    if config_object is None:
        app.config.from_object(Config)
    elif isinstance(config_object, dict):
        app.config.from_object(Config)
        app.config.update(config_object)
    else:
        app.config.from_object(config_object)

    # Путь к локалям задаём в конфиге один раз
    app.config.setdefault("LOCALES_DIR", str(Path(app.root_path).parent / "locales"))
    # Каталог аватарок создаём сразу: иначе первая же загрузка упадёт
    Path(app.config["AVATAR_DIR"]).mkdir(parents=True, exist_ok=True)

    # --- БД -------------------------------------------------------------
    db_module.init_db(app)

    # --- HTTP -----------------------------------------------------------
    app.register_blueprint(routes.routes_bp)
    app.register_blueprint(auth.auth_bp)
    app.register_blueprint(api.api_bp)

    # --- Socket.IO ------------------------------------------------------
    async_mode = app.config.get("ASYNC_MODE", "gevent")
    try:
        socketio.init_app(
            app,
            async_mode=async_mode,
            cors_allowed_origins=app.config.get("SOCKETIO_CORS_ORIGINS", "*"),
        )
    except ValueError:
        # gevent не установлен — откатываемся на threading
        socketio.init_app(app, async_mode="threading", cors_allowed_origins="*")

    sockets.register(socketio)

    # --- Обработчики ошибок --------------------------------------------
    @app.errorhandler(404)
    def not_found(error):  # pragma: no cover - простой JSON-ответ
        from flask import request

        if request.path.startswith("/api/"):
            return jsonify(ok=False, error="not_found"), 404
        return error, 404

    @app.errorhandler(500)
    def server_error(error):  # pragma: no cover
        from flask import request

        if request.path.startswith("/api/"):
            return jsonify(ok=False, error="server_error"), 500
        return error, 500

    # Контекст для шаблонов: имя приложения и флаг «онбординг пройден»
    @app.context_processor
    def inject_globals():
        from flask import request

        return {
            "app_name": "botyaratalk",
            "onboard_cookie": app.config["ONBOARD_COOKIE"],
            "is_onboarded": request.cookies.get(app.config["ONBOARD_COOKIE"]) == "1",
        }

    return app
