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

from .models import Message, Reaction, Room, db
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
        for slug, user_id, whole_user_left in registry.leave_all(sid):
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

        # Ответ на сообщение: id проверяем, чтобы не привязаться к чужой комнате
        reply_to = data.get("reply_to")
        reply_previews: dict[int, dict] = {}
        if reply_to:
            try:
                reply_id = int(reply_to)
            except (TypeError, ValueError):
                reply_id = 0
            source = db.session.get(Message, reply_id) if reply_id else None
            if source and source.room_id == room.id:
                reply_previews[source.id] = {
                    "id": source.id,
                    "username": source.author.username if source.author else "?",
                    "text": source.text[:180],
                }
            else:
                reply_id = None
        else:
            reply_id = None

        message = Message(room_id=room.id, user_id=user["id"], text=text, reply_to_id=reply_id)
        db.session.add(message)
        db.session.commit()

        payload = message.to_public(reply_previews=reply_previews)
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

    @socketio.on("reaction")
    def on_reaction(data):
        """Ставит/снимает реакцию. Один пользователь — одна реакция на сообщение.

        Повторный клик по тому же эмодзи снимает реакцию, клик по другому —
        заменяет её (как в большинстве мессенджеров).
        """
        user = _user()
        if not user:
            return _err("unauthorized")

        data = data or {}
        slug = str(data.get("room", ""))
        emoji = str(data.get("emoji", ""))[:16]

        room = _room_by_slug(slug)
        if not room:
            return _err("room_not_found")
        if not emoji:
            return _err("empty_reaction")

        try:
            message_id = int(data.get("message_id", 0))
        except (TypeError, ValueError):
            return _err("bad_message")

        message = db.session.get(Message, message_id)
        if not message or message.room_id != room.id:
            return _err("message_not_found")

        existing = Reaction.query.filter_by(message_id=message.id, user_id=user["id"]).first()
        if existing and existing.emoji == emoji:
            db.session.delete(existing)
        elif existing:
            existing.emoji = emoji
        else:
            db.session.add(Reaction(message_id=message.id, user_id=user["id"], emoji=emoji))
        db.session.commit()

        # Перечитываем с реакциями и рассылаем всем в комнате
        db.session.expire_all()
        message = db.session.get(Message, message_id)
        payload = {
            "room": slug,
            "message_id": message.id,
            "reactions": message.reactions_public(),
        }
        socketio.emit("message_reactions", _ok(**payload), to=_text_room(slug))
        return _ok(**payload)

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
    def _announce_voice_left(slug: str, user: dict) -> None:
        """Сообщает комнате, что участник из неё ушёл (и сбрасывает его шаринг)."""
        socketio.emit("voice_user_left", _ok(room=slug, user_id=user["id"]), to=_voice_room(slug))
        socketio.emit(
            "screen_state", _ok(room=slug, user_id=user["id"], sharing=False), to=_voice_room(slug)
        )
        socketio.emit("voice_roster", _ok(room=slug, users=registry.participants(slug)), to=_voice_room(slug))

    @socketio.on("voice_join")
    def on_voice_join(data):
        user = _user()
        if not user:
            return _err("unauthorized")

        slug = str((data or {}).get("room", ""))
        if not _room_by_slug(slug):
            return _err("room_not_found")

        # Каналы, где висели ДРУГИЕ устройства этого пользователя: join()
        # вычищает пользователя из них целиком (один человек — один канал),
        # а уведомления нужно разослать отдельно.
        other_devices = sorted(
            {room for room in registry.rooms_of_user(user["id"]) if room != slug}
        )

        avatar = _avatar_of(user["id"])
        try:
            devices_before, is_new = registry.join(
                slug,
                user["id"],
                user["username"],
                request.sid,
                now=time.time(),
                avatar=avatar,
            )
        except RoomFull:
            return _err("voice_full")

        for other in other_devices:
            sio_leave(_voice_room(other))
            _announce_voice_left(other, user)

        sio_join(_voice_room(slug))

        # Новому устройству — снимок комнаты (список тех, кому он сделает offer).
        emit("room_state", _ok(room=slug, users=registry.participants(slug)))

        if is_new:
            socketio.emit(
                "voice_user_joined",
                _ok(
                    room=slug,
                    user_id=user["id"],
                    username=user["username"],
                    sid=request.sid,
                    avatar=avatar,
                ),
                to=_voice_room(slug),
                skip_sid=request.sid,
            )
            socketio.emit(
                "voice_roster",
                _ok(room=slug, users=registry.participants(slug)),
                to=_voice_room(slug),
            )
        return _ok(room=slug, users=devices_before, self_id=user["id"], sid=request.sid)

    @socketio.on("voice_leave")
    def on_voice_leave(data):
        user = _user()
        if not user:
            return _err("unauthorized")
        slug = str((data or {}).get("room", ""))

        result = registry.leave_device(slug, request.sid)
        if result:
            _, whole_user_left = result
            if whole_user_left:
                # Последнее устройство человека — для собеседников он ушёл
                _announce_voice_left(slug, user)
            else:
                # Осталось другое устройство: собеседникам нужно убрать только
                # это соединение, а сам человек остаётся в канале
                socketio.emit(
                    "voice_device_left",
                    _ok(room=slug, user_id=user["id"], sid=request.sid),
                    to=_voice_room(slug),
                    skip_sid=request.sid,
                )
                socketio.emit(
                    "voice_roster",
                    _ok(room=slug, users=registry.participants(slug)),
                    to=_voice_room(slug),
                )
        sio_leave(_voice_room(slug))
        return _ok(room=slug)

    @socketio.on("avatar_changed")
    def on_avatar_changed(data):
        """Пользователь сменил аватарку — обновляем её у собеседников в звонке."""
        user = _user()
        if not user:
            return _err("unauthorized")

        slug = str((data or {}).get("room", ""))
        avatar = _avatar_of(user["id"])
        if not slug or not registry.is_member(slug, user["id"]):
            return _ok(updated=False)

        # Обновляем аватарку у всех устройств пользователя в этой комнате
        room = registry._rooms.get(slug)  # noqa: SLF001 — нужен доступ к группе
        if room and user["id"] in room.peers:
            for peer in room.peers[user["id"]].values():
                peer.avatar = avatar

        socketio.emit(
            "avatar_changed",
            _ok(room=slug, user_id=user["id"], avatar=avatar),
            to=_voice_room(slug),
            skip_sid=request.sid,
        )
        return _ok(updated=True)

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
        if not registry.set_flag(slug, request.sid, "muted", muted):
            return _err("not_in_voice")
        registry.set_flag(slug, request.sid, "camera", camera)
        socketio.emit(
            "voice_media_state",
            _ok(room=slug, user_id=user["id"], sid=request.sid, muted=muted, camera=camera),
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
        if not registry.set_flag(slug, request.sid, "sharing", True):
            return _err("not_in_voice")
        registry.set_flag(slug, request.sid, "screen_audio", audio)
        socketio.emit(
            "screen_state",
            _ok(room=slug, user_id=user["id"], sid=request.sid, sharing=True, audio=audio),
            to=_voice_room(slug),
        )
        return _ok(audio=audio)

    @socketio.on("screen_stopped")
    def on_screen_stopped(data):
        user = _user()
        if not user:
            return _err("unauthorized")
        slug = str((data or {}).get("room", ""))
        registry.set_flag(slug, request.sid, "sharing", False)
        registry.set_flag(slug, request.sid, "screen_audio", False)
        # sid обязателен: флаг принадлежит устройству, а у человека их может быть
        # несколько — без него клиент не знает, чью демонстрацию гасить
        socketio.emit(
            "screen_state",
            _ok(room=slug, user_id=user["id"], sid=request.sid, sharing=False),
            to=_voice_room(slug),
        )
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

        if not registry.is_member(slug, user["id"]):
            return _err("not_in_voice")

        # Устройства одного человека сидят в разных вкладках, поэтому
        # адресуемся по sid конкретного устройства; user_id остаётся как
        # запасной вариант для совместимости со старым клиентом.
        target_sid = data.get("target_sid")
        peer = registry.peer(slug, target_sid) if target_sid else None
        if peer is None:
            try:
                target_user = int(data.get("target"))
            except (TypeError, ValueError):
                return _err("bad_target")
            candidates = [item for item in registry.participants(slug)
                          if item["user_id"] == target_user]
            if not candidates:
                return _err("target_not_in_voice")
            peer = registry.peer(slug, candidates[0]["sid"])

        if peer.user_id == user["id"] and peer.sid == request.sid:
            return _err("self_target")

        payload = _ok(**build_payload())
        payload["from_sid"] = request.sid
        socketio.emit(event, payload, to=peer.sid)
        return _ok()

    @socketio.on("offer")
    def on_offer(data):
        return _relay(
            "offer",
            data,
            lambda: {
                "from": _user()["id"],
                "from_username": _user()["username"],
                "from_sid": request.sid,
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
                "from_sid": request.sid,
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
                "from_sid": request.sid,
                "candidate": (data or {}).get("candidate"),
                "room": (data or {}).get("room"),
            },
        )


def _avatar_of(user_id: int) -> dict | None:
    """Аватарка пользователя для плиток — чтобы она была видна в звонке."""
    from .models import User

    record = db.session.get(User, user_id)
    return record.avatar_public() if record else None


def get_registry() -> VoiceRegistry:
    """Доступ к реестру голосовых комнат (нужен тестам и health-эндпоинту)."""
    return registry


def reset_registry() -> None:
    """Сброс состояния между тестами."""
    registry.clear()
    _rate_buckets.clear()
