"""WebRTC-сигнализация: учёт участников голосовых каналов и флагов шаринга.

Модуль намеренно не знает про Socket.IO API: сюда передаются «сырые» sid'ы,
а рассылкой занимается app/sockets.py. Так реестр легко тестировать юнит-тестами.
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
    """Участник голосового канала."""

    user_id: int
    username: str
    sid: str
    muted: bool = False
    camera: bool = False
    sharing: bool = False
    screen_audio: bool = False  # демонстрация со звуком системы/вкладки
    joined_at: float = 0.0

    def to_public(self) -> dict:
        return {
            "user_id": self.user_id,
            "username": self.username,
            "muted": self.muted,
            "camera": self.camera,
            "sharing": self.sharing,
            "screen_audio": self.screen_audio,
        }


@dataclass
class VoiceRoom:
    slug: str
    peers: dict[int, VoicePeer] = field(default_factory=dict)

    def to_public(self) -> list[dict]:
        return [peer.to_public() for peer in self.peers.values()]


class VoiceRegistry:
    """Потокобезопасный реестр голосовых комнат.

    Ключ — user_id: один пользователь занимает одно место в канале, даже если
    открыл две вкладки (вторая перетирает sid первой — см. DECISIONS.md).
    """

    def __init__(self, max_participants: int = MAX_VOICE_PARTICIPANTS):
        self._rooms: dict[str, VoiceRoom] = {}
        self._lock = threading.RLock()
        self.max_participants = max_participants

    # --- вход/выход -----------------------------------------------------
    def join(
        self, slug: str, user_id: int, username: str, sid: str, now: float = 0.0
    ) -> tuple[list[dict], bool]:
        """Добавляет участника в комнату.

        Возвращает ``(список участников до входа, вошёл_ли_впервые)``.
        Если пользователь уже в этой комнате — просто обновляем sid.

        ВАЖНО: один пользователь занимает ровно одно место во всём реестре.
        Без этого при переходе «канал 1 → канал 2 → канал 3» из-за гонки
        оставались призраки: в старых комнатах тот же человек продолжал
        висеть, и получалось «два меня в двух каналах».
        """
        with self._lock:
            # Сначала вычищаем пользователя из всех остальных голосовых комнат
            self._remove_user_everywhere(user_id, keep=slug)

            room = self._rooms.setdefault(slug, VoiceRoom(slug=slug))
            existing = room.peers.get(user_id)
            if existing:
                existing.sid = sid
                existing.username = username
                return room.to_public(), False

            if len(room.peers) >= self.max_participants:
                raise RoomFull(f"voice room {slug!r} is full")

            before = room.to_public()
            room.peers[user_id] = VoicePeer(
                user_id=user_id, username=username, sid=sid, joined_at=now
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
        """Атомарно переводит пользователя из канала в канал.

        Возвращает ``(снимок старой комнаты, участники новой, вошёл_ли_впервые)``.
        Обе операции идут под одним локом, поэтому промежуточное состояние
        «я сразу в двух каналах» недостижимо.
        """
        with self._lock:
            left = self.leave(from_slug, user_id)
            before, is_new = self.join(to_slug, user_id, username, sid, now=now)
            return {"left": left}, before, is_new

    def leave(self, slug: str, user_id: int) -> bool:
        """Убирает участника; True — если он действительно был в канале."""
        with self._lock:
            room = self._rooms.get(slug)
            if not room or user_id not in room.peers:
                return False
            del room.peers[user_id]
            if not room.peers:
                self._rooms.pop(slug, None)
            return True

    def leave_all(self, sid: str) -> list[tuple[str, int]]:
        """Убирает sid из всех комнат (вызывается при disconnect).

        Возвращает список ``(slug, user_id)``, о которых надо уведомить.
        """
        removed: list[tuple[str, int]] = []
        with self._lock:
            for slug, room in list(self._rooms.items()):
                for user_id, peer in list(room.peers.items()):
                    if peer.sid == sid:
                        del room.peers[user_id]
                        removed.append((slug, user_id))
                if not room.peers:
                    self._rooms.pop(slug, None)
        return removed

    def set_flag(self, slug: str, user_id: int, flag: str, value: bool) -> bool:
        """Меняет флаг участника (muted / camera / sharing / screen_audio)."""
        with self._lock:
            room = self._rooms.get(slug)
            peer = room.peers.get(user_id) if room else None
            if not peer:
                return False
            setattr(peer, flag, value)
            return True

    # --- запросы --------------------------------------------------------
    def participants(self, slug: str) -> list[dict]:
        with self._lock:
            room = self._rooms.get(slug)
            return room.to_public() if room else []

    def peer(self, slug: str, user_id: int) -> VoicePeer | None:
        with self._lock:
            room = self._rooms.get(slug)
            return room.peers.get(user_id) if room else None

    def rooms_of_user(self, user_id: int) -> list[str]:
        """Все комнаты, где сейчас числится пользователь (для отладки и чистки)."""
        with self._lock:
            return [slug for slug, room in self._rooms.items() if user_id in room.peers]

    def rooms_of_sid(self, sid: str) -> list[str]:
        with self._lock:
            return [slug for slug, room in self._rooms.items() if any(p.sid == sid for p in room.peers.values())]

    def is_member(self, slug: str, user_id: int) -> bool:
        return self.peer(slug, user_id) is not None

    def snapshot(self) -> dict[str, list[dict]]:
        """Для отладки/health-эндпоинта."""
        with self._lock:
            return {slug: room.to_public() for slug, room in self._rooms.items()}

    def clear(self) -> None:
        with self._lock:
            self._rooms.clear()


class RoomFull(Exception):
    """Голосовая комната переполнена (mesh не резиновый)."""
