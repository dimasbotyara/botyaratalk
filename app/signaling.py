"""WebRTC-сигнализация: учёт участников голосовых каналов и флагов шаринга.

Модуль намеренно не знает про Socket.IO API: сюда передаются «сырые» sid'ы,
а рассылкой занимается app/sockets.py. Так реестр легко тестировать юнит-тестами.

Ключевое понятие — **устройство** (sid / connection id). Один пользователь
может быть в одном и том же голосовом канале с двух устройств (телефон +
ноутбук) — это нормальный сценарий, а не баг. Поэтому:

* один `user_id` живёт **ровно в одной голосовой комнате**;
* внутри комнаты у него может быть **несколько устройств**, каждое со своим
  `sid`, микрофоном, камерой и демонстрацией;
* в интерфейсе устройства одного человека объединяются в одну плитку.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

# Максимум участников в mesh-комнате. Топология «каждый с каждым» даёт
# N*(N-1)/2 соединений — за пределами 4 человек LAN-сервер и браузеры
# начинают задыхаться, поэтому ставим осознанный лимит.
MAX_VOICE_PARTICIPANTS = 8


@dataclass
class VoicePeer:
    """Устройство (вкладка/браузер) участника голосового канала."""

    user_id: int
    username: str
    sid: str
    muted: bool = False
    camera: bool = False
    sharing: bool = False
    screen_audio: bool = False  # демонстрация со звуком системы/вкладки
    joined_at: float = 0.0
    avatar: dict | None = None

    def to_public(self) -> dict:
        return {
            "user_id": self.user_id,
            "username": self.username,
            "sid": self.sid,
            "muted": self.muted,
            "camera": self.camera,
            "sharing": self.sharing,
            "screen_audio": self.screen_audio,
            "avatar": self.avatar,
        }


@dataclass
class VoiceRoom:
    slug: str
    # user_id → {sid: VoicePeer}: у одного человека бывает несколько устройств
    peers: dict[int, dict[str, VoicePeer]] = field(default_factory=dict)

    def devices(self) -> list[VoicePeer]:
        """Плоский список всех устройств комнаты."""
        return [peer for group in self.peers.values() for peer in group.values()]

    def to_public(self) -> list[dict]:
        """Плоский список: клиенту нужно знать про каждое устройство отдельно,
        чтобы строить отдельные WebRTC-соединения."""
        return [peer.to_public() for peer in self.devices()]

    def find(self, sid: str) -> VoicePeer | None:
        for peer in self.devices():
            if peer.sid == sid:
                return peer
        return None


class VoiceRegistry:
    """Потокобезопасный реестр голосовых комнат.

    Инвариант: пользователь числится ровно в одной комнате (``rooms_of_user``
    вернёт 0 или 1 элемент), но устройств в этой комнате может быть несколько.
    """

    def __init__(self, max_participants: int = MAX_VOICE_PARTICIPANTS):
        self._rooms: dict[str, VoiceRoom] = {}
        self._lock = threading.RLock()
        self.max_participants = max_participants

    # --- вход/выход -----------------------------------------------------
    def join(
        self,
        slug: str,
        user_id: int,
        username: str,
        sid: str,
        now: float = 0.0,
        avatar: dict | None = None,
    ) -> tuple[list[dict], bool]:
        """Добавляет устройство в комнату.

        Возвращает ``(список устройств до входа, вошёл_ли_этот_устройство_впервые)``.

        ВАЖНО: пользователь занимает место ровно в одной комнате во всём реестре.
        Без этого при переходе «канал 1 → канал 2 → канал 3» из-за гонки
        оставались призраки: в старых комнатах тот же человек продолжал
        висеть, и получалось «два меня в двух каналах».
        """
        with self._lock:
            # Сначала вычищаем пользователя из всех остальных голосовых комнат
            self._remove_user_everywhere(user_id, keep=slug)

            room = self._rooms.setdefault(slug, VoiceRoom(slug=slug))
            before = room.to_public()

            existing = room.find(sid)
            if existing and existing.user_id == user_id:
                # То же устройство переподключилось — обновляем данные
                existing.username = username
                existing.avatar = avatar
                return before, False

            # Лимит считаем по людям, а не по устройствам: 8 человек в mesh.
            # Проверяем ДО того, как создадим пустую группу для нового человека.
            if user_id not in room.peers and len(room.peers) >= self.max_participants:
                if not room.peers:
                    self._rooms.pop(slug, None)
                raise RoomFull(f"voice room {slug!r} is full")

            group = room.peers.setdefault(user_id, {})
            group[sid] = VoicePeer(
                user_id=user_id,
                username=username,
                sid=sid,
                joined_at=now,
                avatar=avatar,
            )
            return before, True

    def _remove_user_everywhere(self, user_id: int, keep: str | None = None) -> list[str]:
        """Убирает пользователя из всех комнат, кроме ``keep``.

        Возвращает список комнат, из которых он реально выпал — по ним нужно
        разослать ``voice_user_left`` и обновлённый ростер.
        """
        dropped: list[str] = []
        for slug, room in list(self._rooms.items()):
            if slug == keep or user_id not in room.peers:
                continue
            del room.peers[user_id]
            dropped.append(slug)
            if not room.peers:
                self._rooms.pop(slug, None)
        return dropped

    def switch(self, from_slug: str, to_slug: str, user_id: int, username: str, sid: str,
               now: float = 0.0) -> tuple[dict, list[dict], bool]:
        """Атомарно переводит устройство из канала в канал.

        Возвращает ``(снимок старой комнаты, устройства новой, вошёл_ли_впервые)``.
        Обе операции идут под одним локом, поэтому промежуточное состояние
        «я сразу в двух каналах» недостижимо.
        """
        with self._lock:
            left = self.leave_device(from_slug, sid)
            before, is_new = self.join(to_slug, user_id, username, sid, now=now)
            return {"left": left}, before, is_new

    def leave(self, slug: str, user_id: int) -> bool:
        """Убирает пользователя из комнаты целиком (все его устройства)."""
        with self._lock:
            room = self._rooms.get(slug)
            if not room or user_id not in room.peers:
                return False
            del room.peers[user_id]
            if not room.peers:
                self._rooms.pop(slug, None)
            return True

    def leave_device(self, slug: str, sid: str) -> tuple[int, bool] | None:
        """Убирает одно устройство.

        Возвращает ``(user_id, ушёл_ли_пользователь_из_комнаты_целиком)``
        либо ``None``, если такого устройства в комнате нет.
        """
        with self._lock:
            room = self._rooms.get(slug)
            if not room:
                return None
            peer = room.find(sid)
            if not peer:
                return None
            group = room.peers.get(peer.user_id, {})
            group.pop(sid, None)
            whole_user_left = not group
            if whole_user_left:
                room.peers.pop(peer.user_id, None)
            if not room.peers:
                self._rooms.pop(slug, None)
            return peer.user_id, whole_user_left

    def leave_all(self, sid: str) -> list[tuple[str, int, bool]]:
        """Убирает устройство из всех комнат (вызывается при disconnect).

        Возвращает список ``(slug, user_id, ушёл_ли_целиком)``.
        """
        removed: list[tuple[str, int, bool]] = []
        with self._lock:
            for slug, room in list(self._rooms.items()):
                peer = room.find(sid)
                if not peer:
                    continue
                group = room.peers.get(peer.user_id, {})
                group.pop(sid, None)
                whole_user_left = not group
                if whole_user_left:
                    room.peers.pop(peer.user_id, None)
                removed.append((slug, peer.user_id, whole_user_left))
                if not room.peers:
                    self._rooms.pop(slug, None)
        return removed

    def set_flag(self, slug: str, sid: str, flag: str, value: bool) -> bool:
        """Меняет флаг устройства (muted / camera / sharing / screen_audio)."""
        with self._lock:
            room = self._rooms.get(slug)
            peer = room.find(sid) if room else None
            if not peer:
                return False
            setattr(peer, flag, value)
            return True

    def set_flag_for_user(self, slug: str, user_id: int, flag: str, value: bool) -> bool:
        """Меняет флаг у всех устройств пользователя (для тестов и отладки)."""
        with self._lock:
            room = self._rooms.get(slug)
            group = room.peers.get(user_id) if room else None
            if not group:
                return False
            for peer in group.values():
                setattr(peer, flag, value)
            return True

    # --- запросы --------------------------------------------------------
    def participants(self, slug: str) -> list[dict]:
        with self._lock:
            room = self._rooms.get(slug)
            return room.to_public() if room else []

    def peer(self, slug: str, sid: str) -> VoicePeer | None:
        with self._lock:
            room = self._rooms.get(slug)
            return room.find(sid) if room else None

    def device(self, slug: str, sid: str) -> VoicePeer | None:
        """Псевдоним ``peer`` — читается понятнее там, где речь об устройстве."""
        return self.peer(slug, sid)

    def devices_count(self, slug: str) -> int:
        with self._lock:
            room = self._rooms.get(slug)
            return len(room.devices()) if room else 0

    def users_count(self, slug: str) -> int:
        with self._lock:
            room = self._rooms.get(slug)
            return len(room.peers) if room else 0

    def rooms_of_user(self, user_id: int) -> list[str]:
        """Все комнаты, где сейчас числится пользователь (их всегда 0 или 1)."""
        with self._lock:
            return [slug for slug, room in self._rooms.items() if user_id in room.peers]

    def rooms_of_sid(self, sid: str) -> list[str]:
        with self._lock:
            return [slug for slug, room in self._rooms.items() if room.find(sid)]

    def is_member(self, slug: str, user_id: int) -> bool:
        with self._lock:
            room = self._rooms.get(slug)
            return bool(room and user_id in room.peers)

    def is_device_member(self, slug: str, sid: str) -> bool:
        return self.peer(slug, sid) is not None

    def snapshot(self) -> dict[str, list[dict]]:
        """Для отладки/health-эндпоинта."""
        with self._lock:
            return {slug: room.to_public() for slug, room in self._rooms.items()}

    def clear(self) -> None:
        with self._lock:
            self._rooms.clear()


class RoomFull(Exception):
    """Голосовая комната переполнена (mesh не резиновый)."""
