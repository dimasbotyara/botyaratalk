"""Socket.IO: текстовый чат, presence и WebRTC-сигнализация.

Здесь собраны все обработчики. Логика учёта голосовых участников вынесена в
``signaling.py``, чтобы не смешивать транспорт и состояние.
"""

from __future__ import annotations

import time
from collections import deque

from flask import current_app, request
from flask_socketio import emit
from flask_socketio import join_room as sio_join
from flask_socketio import leave_room as sio_leave

from .models import Message, Room, db
from .signaling import RoomFull, VoiceRegistry

registry = VoiceRegistry()

# Простейший антифлуд: user_id -> очередь отметок времени.
_rate_buckets: dict[int, deque] = {}


def _ok(**payload) -> dict:
    payload.setdefault("ok", True)
    return payload


def _err(code: str, **payload) -> dict:
    payload.update(ok=False, error=code)
    return payload


def _user() -> dict | None:
    """Данные пользователя из сессии Socket.IO-соединения."""
    from flask import session

    user_id = session.get("user_id")
    if not user_id:
        return None
    return {"id": user_id, "username": session.get("username", "?")}


def _room_by_slug(slug: str) -> Room | None:
    return Room.query.filter_by(slug=slug).first()


def _text_room(slug: str) -> str:
    return f"text-{slug}"


def _voice_room(slug: str) -> str:
    return f"voice-{slug}"


def _rate_limited(user_id: int) -> bool:
    limit, window = current_app.config["MESSAGE_RATE_LIMIT"]
    now = time.time()
    bucket = _rate_buckets.setdefault(user_id, deque(maxlen=limit))
    while bucket and now - bucket[0] > window:
        bucket.popleft()
    if len(bucket) >= limit:
        return True
    bucket.append(now)
    return False


# =========================================================================
# Подключение / отключение
# =========================================================================
def register(socketio) -> None:
    """Регистрирует все обработчики на экземпляре SocketIO."""

    @socketio.on("connect")
    def on_connect(auth=None):
        user = _user()
        if not user:
            # Неавторизованные соединения не держим — иначе можно слушать чат
            return False
        emit("connected", _ok(user=user))

    @socketio.on("disconnect")
    def on_disconnect(reason=None):
        user = _user()
        sid = request.sid

        # 1) убираем из всех голосовых комнат
        for slug, user_id in registry.leave_all(sid):
            socketio.emit(
                "voice_user_left",
                _ok(user_id=user_id, room=slug),
                to=_voice_room(slug),
            )
            socketio.emit("voice_roster", _ok(room=slug, users=registry.participants(slug)), to=_voice_room(slug))
            socketio.emit("screen_state", _ok(user_id=user_id, sharing=False, room=slug), to=_voice_room(slug))

        # 2) выходим из текстовых комнат (Socket.IO сам чистит sid при
        # disconnect, но явный выход оставляет состояние предсказуемым)
        if user:
            for room in list(socketio.server.rooms(sid)):
                if isinstance(room, str) and room.startswith("text-"):
                    sio_leave(room)

    # =====================================================================
    # Текстовые каналы
    # =====================================================================
    @socketio.on("join_room")
    def on_join_room(data):
        user = _user()
        if not user:
            return _err("unauthorized")
        slug = str((data or {}).get("room", ""))
        room = _room_by_slug(slug)
        if not room:
            return _err("room_not_found")

        # Один текстовый канал на пользователя: выходим из предыдущих.
        for current in socketio.server.rooms(request.sid):
            if isinstance(current, str) and current.startswith("text-") and current != _text_room(slug):
                sio_leave(current)

        sio_join(_text_room(slug))
        return _ok(room=slug, channel=room.text_channel)

    @socketio.on("leave_room")
    def on_leave_room(data):
        slug = str((data or {}).get("room", ""))
        sio_leave(_text_room(slug))
        return _ok(room=slug)

    @socketio.on("text_message")
    def on_text_message(data):
        """Сохраняет сообщение и рассылает его.

        - ``text_message`` уходит всем в комнате (включая автора);
        - ``message_notification`` — всем остальным соединениям, чтобы клиент
          мог показать браузерное уведомление и бейдж непрочитанных.
        """
        user = _user()
        if not user:
            return _err("unauthorized")

        data = data or {}
        slug = str(data.get("room", ""))
        text = str(data.get("text", "")).strip()

        room = _room_by_slug(slug)
        if not room:
            return _err("room_not_found")
        if not text:
            return _err("empty_message")
        if len(text) > current_app.config["MESSAGE_MAX_LEN"]:
            return _err("message_too_long")

        if _rate_limited(user["id"]):
            return _err("rate_limited")

        message = Message(room_id=room.id, user_id=user["id"], text=text)
        db.session.add(message)
        db.session.commit()

        payload = message.to_public()
        socketio.emit("text_message", _ok(**payload), to=_text_room(slug))

        # Уведомления: шлём всем, клиент сам решит, показывать ли.
        notification = {
            "room": slug,
            "room_name_key": room.name_key,
            "username": user["username"],
            "text": text[:140],
            "ts": payload["ts"],
            "id": payload["id"],
        }
        socketio.emit("message_notification", _ok(**notification), skip_sid=request.sid)
        return _ok(id=payload["id"], ts=payload["ts"])

    @socketio.on("typing")
    def on_typing(data):
        """Индикатор набора текста (небольшой бонус, не в основном скоупе)."""
        user = _user()
        if not user:
            return _err("unauthorized")
        slug = str((data or {}).get("room", ""))
        socketio.emit(
            "typing",
            _ok(room=slug, username=user["username"], user_id=user["id"]),
            to=_text_room(slug),
            skip_sid=request.sid,
        )
        return _ok()

    # =====================================================================
    # Голосовые каналы
    # =====================================================================
    @socketio.on("voice_join")
    def on_voice_join(data):
        user = _user()
        if not user:
            return _err("unauthorized")

        slug = str((data or {}).get("room", ""))
        if not _room_by_slug(slug):
            return _err("room_not_found")

        try:
            participants_before, is_new = registry.join(
                slug, user["id"], user["username"], request.sid, now=time.time()
            )
        except RoomFull:
            return _err("voice_full")

        sio_join(_voice_room(slug))

        # Новому участнику — снимок комнаты (список тех, кому он сделает offer).
        emit("room_state", _ok(room=slug, users=registry.participants(slug)))

        if is_new:
            # Остальным — уведомление о новичке + актуальный ростер.
            socketio.emit(
                "voice_user_joined",
                _ok(room=slug, user_id=user["id"], username=user["username"]),
                to=_voice_room(slug),
                skip_sid=request.sid,
            )
            socketio.emit(
                "voice_roster",
                _ok(room=slug, users=registry.participants(slug)),
                to=_voice_room(slug),
            )
        return _ok(room=slug, users=participants_before, self_id=user["id"])

    @socketio.on("voice_leave")
    def on_voice_leave(data):
        user = _user()
        if not user:
            return _err("unauthorized")
        slug = str((data or {}).get("room", ""))
        if registry.leave(slug, user["id"]):
            socketio.emit("voice_user_left", _ok(room=slug, user_id=user["id"]), to=_voice_room(slug))
            socketio.emit("screen_state", _ok(room=slug, user_id=user["id"], sharing=False), to=_voice_room(slug))
            socketio.emit("voice_roster", _ok(room=slug, users=registry.participants(slug)), to=_voice_room(slug))
        sio_leave(_voice_room(slug))
        return _ok(room=slug)

    @socketio.on("voice_media_state")
    def on_voice_media_state(data):
        """Синхронизация mute / камеры между участниками (для индикаторов)."""
        user = _user()
        if not user:
            return _err("unauthorized")
        data = data or {}
        slug = str(data.get("room", ""))
        muted = bool(data.get("muted", False))
        camera = bool(data.get("camera", False))
        if not registry.set_flag(slug, user["id"], "muted", muted):
            return _err("not_in_voice")
        registry.set_flag(slug, user["id"], "camera", camera)
        socketio.emit(
            "voice_media_state",
            _ok(room=slug, user_id=user["id"], muted=muted, camera=camera),
            to=_voice_room(slug),
        )
        return _ok()

    @socketio.on("screen_started")
    def on_screen_started(data):
        user = _user()
        if not user:
            return _err("unauthorized")
        data = data or {}
        slug = str(data.get("room", ""))
        audio = bool(data.get("audio", False))
        if not registry.set_flag(slug, user["id"], "sharing", True):
            return _err("not_in_voice")
        socketio.emit(
            "screen_state",
            _ok(room=slug, user_id=user["id"], sharing=True, audio=audio),
            to=_voice_room(slug),
        )
        return _ok(audio=audio)

    @socketio.on("screen_stopped")
    def on_screen_stopped(data):
        user = _user()
        if not user:
            return _err("unauthorized")
        slug = str((data or {}).get("room", ""))
        registry.set_flag(slug, user["id"], "sharing", False)
        socketio.emit("screen_state", _ok(room=slug, user_id=user["id"], sharing=False), to=_voice_room(slug))
        return _ok()

    # =====================================================================
    # Сигнализация WebRTC (offer / answer / ICE)
    # =====================================================================
    def _relay(event: str, data: dict, build_payload):
        """Общая обвязка для offer/answer/ice_candidate.

        Проверяем, что отправитель и получатель — в одном голосовом канале,
        и пересылаем сообщение конкретному sid'у получателя (по user_id).
        """
        user = _user()
        if not user:
            return _err("unauthorized")

        data = data or {}
        slug = str(data.get("room", ""))
        try:
            target = int(data.get("target"))
        except (TypeError, ValueError):
            return _err("bad_target")

        if not registry.is_member(slug, user["id"]):
            return _err("not_in_voice")
        peer = registry.peer(slug, target)
        if not peer:
            return _err("target_not_in_voice")
        if peer.user_id == user["id"]:
            return _err("self_target")

        socketio.emit(
            event,
            _ok(**build_payload()),
            to=peer.sid,
        )
        return _ok()

    @socketio.on("offer")
    def on_offer(data):
        return _relay(
            "offer",
            data,
            lambda: {
                "from": _user()["id"],
                "from_username": _user()["username"],
                "sdp": (data or {}).get("sdp"),
                "room": (data or {}).get("room"),
            },
        )

    @socketio.on("answer")
    def on_answer(data):
        return _relay(
            "answer",
            data,
            lambda: {
                "from": _user()["id"],
                "sdp": (data or {}).get("sdp"),
                "room": (data or {}).get("room"),
            },
        )

    @socketio.on("ice_candidate")
    def on_ice_candidate(data):
        return _relay(
            "ice_candidate",
            data,
            lambda: {
                "from": _user()["id"],
                "candidate": (data or {}).get("candidate"),
                "room": (data or {}).get("room"),
            },
        )


def reset_registry() -> None:
    """Сброс состояния между тестами."""
    registry.clear()
    _rate_buckets.clear()
