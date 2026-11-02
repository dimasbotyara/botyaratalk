"""Тесты Socket.IO: текстовый чат, сигнализация, реестр голосовых комнат.

flask-socketio's test client не умеет работать с cookie-сессиями напрямую,
поэтому обработчики вызываются через клиент с подменённой сессией — смотрим
на реальные события, которые сервер отдаёт клиенту.
"""

from __future__ import annotations

import pytest

from app.signaling import MAX_VOICE_PARTICIPANTS, VoiceRegistry


# --------------------------------------------------------------------------
# Юнит-тесты реестра голосовых комнат (без Socket.IO)
# --------------------------------------------------------------------------
def test_registry_join_leave():
    registry = VoiceRegistry()
    before, is_new = registry.join("channel-1", 1, "alice", "sid-a", now=1.0)
    assert before == [] and is_new is True

    before2, is_new2 = registry.join("channel-1", 2, "bob", "sid-b", now=2.0)
    assert is_new2 is True
    assert [user["username"] for user in before2] == ["alice"]
    assert len(registry.participants("channel-1")) == 2

    assert registry.leave("channel-1", 1) is True
    assert registry.leave("channel-1", 1) is False
    assert [user["username"] for user in registry.participants("channel-1")] == ["bob"]


def test_registry_rejoin_same_user_keeps_single_slot():
    registry = VoiceRegistry()
    registry.join("channel-3", 7, "carol", "sid-1")
    before, is_new = registry.join("channel-3", 7, "carol", "sid-2")
    assert is_new is False
    assert len(registry.participants("channel-3")) == 1
    assert registry.peer("channel-3", 7).sid == "sid-2"


def test_registry_max_participants():
    registry = VoiceRegistry(max_participants=2)
    registry.join("channel-2", 1, "a", "s1")
    registry.join("channel-2", 2, "b", "s2")
    with pytest.raises(Exception):
        registry.join("channel-2", 3, "c", "s3")


def test_registry_leave_all_by_sid():
    registry = VoiceRegistry()
    registry.join("channel-1", 1, "a", "shared-sid")
    registry.join("channel-2", 1, "a", "shared-sid")
    removed = registry.leave_all("shared-sid")
    assert sorted(slug for slug, _ in removed) == ["channel-1", "channel-2"]
    assert registry.participants("channel-1") == []


def test_registry_flags():
    registry = VoiceRegistry()
    registry.join("channel-1", 1, "a", "s1")
    assert registry.set_flag("channel-1", 1, "sharing", True) is True
    assert registry.peer("channel-1", 1).sharing is True
    assert registry.set_flag("channel-1", 99, "sharing", True) is False


# --------------------------------------------------------------------------
# Тесты Socket.IO-обработчиков
# --------------------------------------------------------------------------
def test_socket_connects_and_reports_user(socket_authed):
    client, user = socket_authed()
    assert user["id"] > 0
    assert client.is_connected()
    received = client.get_received()
    assert any(event["name"] == "connected" for event in received)


def test_text_message_is_persisted_and_broadcast(app, socket_authed):
    client, user = socket_authed()
    user_id = user["id"]
    client.get_received()  # очищаем приветственные события

    # Входим в комнату — сервер должен ответить ack'ом
    ack = client.emit("join_room", {"room": "channel-1"}, callback=True)
    assert ack.get("ok") is True

    ack = client.emit("text_message", {"room": "channel-1", "text": "привет из теста"}, callback=True)
    assert ack.get("ok") is True
    assert ack.get("id")

    events = [event["name"] for event in client.get_received()]
    assert "text_message" in events

    with app.app_context():
        from app.models import Message

        message = Message.query.first()
        assert message is not None
        assert message.text == "привет из теста"
        assert message.author.id == user_id


def test_empty_and_too_long_messages_rejected(socket_authed):
    client, _ = socket_authed()
    client.emit("join_room", {"room": "channel-1"})

    empty = client.emit("text_message", {"room": "channel-1", "text": "   "}, callback=True)
    assert empty.get("ok") is False and empty.get("error") == "empty_message"

    too_long = client.emit("text_message", {"room": "channel-1", "text": "x" * 5000}, callback=True)
    assert too_long.get("ok") is False and too_long.get("error") == "message_too_long"


def test_unknown_room_rejected(socket_authed):
    client, _ = socket_authed()
    ack = client.emit("join_room", {"room": "does-not-exist"}, callback=True)
    assert ack.get("ok") is False
    assert ack.get("error") == "room_not_found"


def test_voice_join_and_leave(socket_authed, app):
    client, user = socket_authed()
    user_id = user["id"]
    client.get_received()

    ack = client.emit("voice_join", {"room": "channel-1"}, callback=True)
    assert ack.get("ok") is True
    assert ack.get("users") == []
    assert ack.get("self_id") == user_id

    from app.sockets import registry

    assert len(registry.participants("channel-1")) == 1

    ack = client.emit("voice_leave", {"room": "channel-1"}, callback=True)
    assert ack.get("ok") is True
    assert registry.participants("channel-1") == []


def test_signaling_requires_target_in_same_room(socket_authed):
    client, _ = socket_authed()
    client.emit("voice_join", {"room": "channel-1"})
    client.get_received()

    ack = client.emit(
        "offer",
        {"target": 9999, "sdp": {"type": "offer", "sdp": "v=0"}, "room": "channel-1"},
        callback=True,
    )
    assert ack.get("ok") is False
    assert ack.get("error") == "target_not_in_voice"


def test_signaling_requires_being_in_voice(socket_authed):
    client, _ = socket_authed()
    ack = client.emit(
        "ice_candidate",
        {"target": 1, "candidate": {"candidate": "x"}, "room": "channel-1"},
        callback=True,
    )
    assert ack.get("ok") is False
    assert ack.get("error") == "not_in_voice"


def test_screen_state_events(socket_authed):
    client, user = socket_authed()
    user_id = user["id"]
    client.emit("voice_join", {"room": "channel-1"})
    client.get_received()

    ack = client.emit("screen_started", {"room": "channel-1"}, callback=True)
    assert ack.get("ok") is True

    from app.sockets import registry

    assert registry.peer("channel-1", user_id).sharing is True

    client.emit("screen_stopped", {"room": "channel-1"})
    assert registry.peer("channel-1", user_id).sharing is False


def test_max_participants_constant_documented():
    # Mesh-топология: держим лимит небольшим, чтобы LAN-сервер не захлебнулся
    assert 2 <= MAX_VOICE_PARTICIPANTS <= 10
