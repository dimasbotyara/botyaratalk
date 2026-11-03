"""Тесты Socket.IO: текстовый чат, сигнализация, реестр голосовых комнат.

flask-socketio's test client не умеет работать с cookie-сессиями напрямую,
поэтому обработчики вызываются через клиент с подменённой сессией — смотрим
на реальные события, которые сервер отдаёт клиенту.
"""

from __future__ import annotations

import pytest

from app.signaling import MAX_VOICE_PARTICIPANTS, RoomFull, VoiceRegistry


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


def test_registry_same_device_rejoin_is_idempotent():
    """То же устройство переподключилось — место не дублируется."""
    registry = VoiceRegistry()
    registry.join("channel-3", 7, "carol", "sid-1")
    before, is_new = registry.join("channel-3", 7, "carol", "sid-1")
    assert is_new is False
    assert len(registry.participants("channel-3")) == 1
    assert registry.users_count("channel-3") == 1


def test_registry_second_device_joins_same_channel():
    """Тот же аккаунт с другого устройства — второе соединение в том же канале."""
    registry = VoiceRegistry()
    registry.join("channel-3", 7, "carol", "sid-phone")
    before, is_new = registry.join("channel-3", 7, "carol", "sid-laptop")

    assert is_new is True
    # Оба устройства на месте, но человек по-прежнему один
    assert len(registry.participants("channel-3")) == 2
    assert registry.users_count("channel-3") == 1
    assert len(before) == 1


def test_registry_second_device_in_other_channel_moves_user():
    """Второе устройство в другом канале переносит человека целиком."""
    registry = VoiceRegistry()
    registry.join("channel-1", 7, "carol", "sid-phone")
    registry.join("channel-2", 7, "carol", "sid-laptop")

    # Человек ровно в одном канале, второе устройство добавилось туда же
    assert registry.rooms_of_user(7) == ["channel-2"]
    assert registry.participants("channel-1") == []
    assert registry.users_count("channel-2") == 1


def test_registry_leave_one_device_keeps_user_in_channel():
    """Ушло одно устройство — человек остаётся в канале со второго."""
    registry = VoiceRegistry()
    registry.join("channel-1", 7, "carol", "sid-phone")
    registry.join("channel-1", 7, "carol", "sid-laptop")

    result = registry.leave_device("channel-1", "sid-phone")
    assert result == (7, False)  # пользователь ещё здесь
    assert registry.is_member("channel-1", 7) is True
    assert len(registry.participants("channel-1")) == 1

    result = registry.leave_device("channel-1", "sid-laptop")
    assert result == (7, True)  # ушёл последним
    assert registry.is_member("channel-1", 7) is False


def test_registry_max_participants():
    """Лимит считается по людям, а не по устройствам."""
    registry = VoiceRegistry(max_participants=2)
    registry.join("channel-2", 1, "a", "s1")
    registry.join("channel-2", 2, "b", "s2")
    with pytest.raises(RoomFull):
        registry.join("channel-2", 3, "c", "s3")

    # Второе устройство уже присутствующего человека лимит не нарушает
    before, is_new = registry.join("channel-2", 1, "a", "s1-second")
    assert is_new is True
    assert len(before) == 2


def test_registry_leave_all_by_sid():
    """Один и тот же sid может принадлежать двум разным пользователям
    (например, две вкладки с разными аккаунтами) — leave_all чистит обоих."""
    registry = VoiceRegistry()
    registry.join("channel-1", 1, "a", "shared-sid")
    registry.join("channel-2", 2, "b", "shared-sid")
    removed = registry.leave_all("shared-sid")
    assert sorted(slug for slug, _, _ in removed) == ["channel-1", "channel-2"]
    assert registry.participants("channel-1") == []
    assert registry.participants("channel-2") == []


def test_registry_flags():
    """Флаги принадлежат устройству: у телефона и ноутбука они независимы."""
    registry = VoiceRegistry()
    registry.join("channel-1", 1, "a", "s1")
    registry.join("channel-1", 1, "a", "s2")

    assert registry.set_flag("channel-1", "s1", "sharing", True) is True
    assert registry.peer("channel-1", "s1").sharing is True
    assert registry.peer("channel-1", "s2").sharing is False
    assert registry.set_flag("channel-1", "nope", "sharing", True) is False


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

    # Демонстрация включается конкретным устройством (sid), а не аккаунтом
    devices = [peer for peer in registry.participants("channel-1") if peer["user_id"] == user_id]
    assert devices and devices[0]["sharing"] is True

    client.emit("screen_stopped", {"room": "channel-1"})
    devices = [peer for peer in registry.participants("channel-1") if peer["user_id"] == user_id]
    assert devices[0]["sharing"] is False


def test_max_participants_constant_documented():
    # Mesh-топология: держим лимит небольшим, чтобы LAN-сервер не захлебнулся
    assert 2 <= MAX_VOICE_PARTICIPANTS <= 10

def test_registry_user_lives_in_exactly_one_voice_room():
    """Баг «два меня в двух каналах»: пользователь не может быть в двух сразу."""
    registry = VoiceRegistry(max_participants=8)
    registry.join("channel-1", 1, "alice", "sid-a")
    assert registry.rooms_of_user(1) == ["channel-1"]

    # Переход в другой канал вычищает предыдущий, даже если клиент не позвал leave
    registry.join("channel-2", 1, "alice", "sid-a")
    assert registry.rooms_of_user(1) == ["channel-2"]
    assert registry.participants("channel-1") == []

    registry.join("channel-3", 1, "alice", "sid-a")
    assert registry.rooms_of_user(1) == ["channel-3"]
    assert registry.participants("channel-1") == []
    assert registry.participants("channel-2") == []
    assert len(registry.participants("channel-3")) == 1


def test_registry_switch_is_atomic():
    """switch() оставляет пользователя ровно в одном канале."""
    registry = VoiceRegistry(max_participants=8)
    registry.join("channel-1", 1, "alice", "sid-a")
    registry.join("channel-1", 2, "bob", "sid-b")

    meta, users_before, is_new = registry.switch("channel-1", "channel-2", 1, "alice", "sid-a")
    # left — результат leave_device: (user_id, ушёл_ли_целиком)
    assert meta["left"] == (1, True)
    assert is_new is True
    assert users_before == []  # в channel-2 до перехода никого не было
    assert registry.rooms_of_user(1) == ["channel-2"]
    assert [peer["username"] for peer in registry.participants("channel-1")] == ["bob"]
    assert [peer["username"] for peer in registry.participants("channel-2")] == ["alice"]


def test_voice_join_releases_previous_channel(app, socket_authed, auth_helper):
    """Через сокет: вход во второй канал убирает пользователя из первого."""
    from app.sockets import get_registry

    client, user = socket_authed()
    client.emit("voice_join", {"room": "channel-1"})
    client.get_received()
    assert get_registry().rooms_of_user(user["id"]) == ["channel-1"]

    client.emit("voice_join", {"room": "channel-2"})
    client.get_received()
    assert get_registry().rooms_of_user(user["id"]) == ["channel-2"]
    assert get_registry().participants("channel-1") == []
