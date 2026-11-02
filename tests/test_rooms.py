"""Тесты комнат и истории сообщений."""

from __future__ import annotations

import pytest


def test_seed_creates_three_rooms(app):
    from app.models import Room

    rooms = Room.query.order_by(Room.position).all()
    assert [room.slug for room in rooms] == ["channel-1", "channel-2", "channel-3"]
    assert [room.text_channel for room in rooms] == ["text-channel-1", "text-channel-2", "text-channel-3"]
    assert [room.voice_channel for room in rooms] == ["voice-channel-1", "voice-channel-2", "voice-channel-3"]
    assert [room.name_key for room in rooms] == ["room.channel_1", "room.channel_2", "room.channel_3"]
    assert [room.text_key for room in rooms] == ["channel.text_1", "channel.text_2", "channel.text_3"]
    assert [room.voice_key for room in rooms] == ["channel.voice_1", "channel.voice_2", "channel.voice_3"]


def test_seed_is_idempotent(app):
    from app.db import seed_rooms
    from app.models import Room

    assert seed_rooms(app) == 0
    assert Room.query.count() == 3


def test_rooms_require_auth(client):
    assert client.get("/api/rooms").status_code == 401


def test_rooms_list_after_login(client, auth_helper):
    auth_helper("roomfan")
    payload = client.get("/api/rooms").get_json()
    assert payload["ok"] is True
    slugs = [room["slug"] for room in payload["rooms"]]
    assert slugs == ["channel-1", "channel-2", "channel-3"]


def test_messages_history_empty(client, auth_helper):
    auth_helper("historyfan")
    payload = client.get("/api/rooms/channel-1/messages").get_json()
    assert payload["ok"] is True
    assert payload["messages"] == []
    assert payload["room"]["slug"] == "channel-1"


def test_messages_history_returns_last_100(app, client, auth_helper):
    auth_helper("spammer")
    from app.models import Message, Room, User, db

    with app.app_context():
        room = Room.query.filter_by(slug="channel-1").first()
        user = User.query.filter_by(username="spammer").first()
        for index in range(130):
            db.session.add(Message(room_id=room.id, user_id=user.id, text=f"msg-{index}"))
        db.session.commit()

    payload = client.get("/api/rooms/channel-1/messages?limit=100").get_json()
    assert len(payload["messages"]) == 100
    assert payload["messages"][-1]["text"] == "msg-129"
    # Порядок хронологический
    assert payload["messages"][0]["text"] == "msg-30"


def test_messages_limit_is_clamped(client, auth_helper):
    auth_helper("clampfan")
    payload = client.get("/api/rooms/channel-1/messages?limit=99999").get_json()
    assert payload["ok"] is True


def test_unknown_room_returns_404(client, auth_helper):
    auth_helper("lostuser")
    assert client.get("/api/rooms/nope/messages").status_code == 404


def test_config_endpoint_exposes_themes(client):
    payload = client.get("/api/config").get_json()
    assert payload["ok"] is True
    assert len(payload["themes"]) == 10
    assert payload["default_theme"] == "catppuccin-mocha"
    assert payload["ice_servers"]


@pytest.mark.parametrize(
    "theme",
    [
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
    ],
)
def test_theme_css_files_exist(app, theme):
    path = app.static_folder + f"/css/themes/{theme}.css"
    with open(path, encoding="utf-8") as handle:
        css = handle.read()
    assert f'[data-theme="{theme}"]' in css
    for variable in ("--bg", "--bg-alt", "--fg", "--fg-muted", "--accent", "--accent-fg",
                     "--border", "--danger", "--success", "--warning", "--hover"):
        assert variable in css
