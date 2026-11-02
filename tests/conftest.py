"""Общие фикстуры pytest: приложение, клиенты, Socket.IO-тест-клиент."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app, socketio  # noqa: E402
from app.models import db  # noqa: E402
from app.sockets import reset_registry  # noqa: E402
from config import TestConfig  # noqa: E402


@pytest.fixture()
def app():
    """Приложение в тестовом режиме: in-memory SQLite, threading Socket.IO."""
    application = create_app(TestConfig)
    with application.app_context():
        db.drop_all()
        db.create_all()
        from app.db import seed_rooms

        seed_rooms(application)
        yield application
        db.session.remove()


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def socketio_client(app):
    """Клиент Socket.IO с уже установленной сессией flask.session."""
    reset_registry()
    client = socketio.test_client(app)
    yield client
    if client.is_connected():
        client.disconnect()
    reset_registry()


@pytest.fixture()
def auth_helper(client):
    """Регистрирует пользователя и возвращает его никнейм."""

    def _register(username="tester", password="secret123"):
        response = client.post(
            "/api/auth/register",
            json={"username": username, "password": password, "password2": password},
        )
        assert response.status_code == 201, response.get_json()
        return response.get_json()["user"]

    return _register


@pytest.fixture()
def socket_authed(app, client):
    """Socket.IO-клиент, авторизованный как обычный пользователь.

    flask-socketio умеет принимать Flask test client — сессия берётся из его
    cookie, поэтому достаточно залогиниться по HTTP, а затем открыть сокет.
    """
    from app import socketio

    created = []

    def _make(username="sockuser", password="supersecret") -> tuple:
        response = client.post(
            "/api/auth/register",
            json={"username": username, "password": password, "password2": password},
        )
        assert response.status_code == 201, response.get_json()
        user = response.get_json()["user"]

        sio_client = socketio.test_client(app, flask_test_client=client)
        created.append(sio_client)
        assert sio_client.is_connected()
        return sio_client, user

    yield _make

    for sio_client in created:
        if sio_client.is_connected():
            sio_client.disconnect()
    reset_registry()
