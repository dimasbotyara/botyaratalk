"""Модели SQLAlchemy: User, Room, Message, RoomMember.

Схема сознательно минимальная: LAN-мессенджер без команд, ролей и вложений.
"""

from __future__ import annotations

from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import UniqueConstraint
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()


def utcnow() -> datetime:
    """Текущее время в UTC (без tzinfo — SQLite не хранит таймзоны)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_now() -> str:
    """ISO-8601 строка с 'Z' — то, что ждёт фронтенд."""
    return utcnow().isoformat(timespec="seconds") + "Z"


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(32), unique=True, nullable=False, index=True)
    username_lower = db.Column(db.String(32), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    last_seen = db.Column(db.DateTime, default=utcnow, nullable=False)

    # Аватарка: либо загруженный файл в instance/avatars, либо сгенерированный
    # пиксельный узор (сид + палитра). Поле kind: 'upload' | 'generated' | None.
    avatar_kind = db.Column(db.String(16), nullable=True)
    avatar_file = db.Column(db.String(64), nullable=True)
    avatar_seed = db.Column(db.String(32), nullable=True)
    avatar_palette = db.Column(db.String(32), nullable=True)
    avatar_density = db.Column(db.Integer, nullable=True)

    messages = db.relationship("Message", back_populates="author", lazy="dynamic")

    # --- пароли ---------------------------------------------------------
    def set_password(self, raw: str) -> None:
        # pbkdf2:sha256 — требование задачи, хотя werkzeug по умолчанию scrypt
        self.password_hash = generate_password_hash(raw, method="pbkdf2:sha256")

    def check_password(self, raw: str) -> bool:
        return check_password_hash(self.password_hash, raw)

    # --- аватарки --------------------------------------------------------
    @property
    def avatar_url(self) -> str | None:
        """URL аватарки: файл из instance/avatars или SVG-генератор."""
        if self.avatar_kind == "upload" and self.avatar_file:
            return f"/api/avatar/{self.username}"
        if self.avatar_kind == "generated":
            from urllib.parse import urlencode

            params = urlencode(
                {
                    "seed": self.avatar_seed or "botyaratalk",
                    "palette": self.avatar_palette or "mocha",
                    "density": self.avatar_density or 30,
                }
            )
            return f"/api/avatar/generated.svg?{params}"
        return None

    def avatar_public(self) -> dict:
        return {
            "kind": self.avatar_kind,
            "url": self.avatar_url,
            "seed": self.avatar_seed,
            "palette": self.avatar_palette,
            "density": self.avatar_density,
        }

    # --- сериализация ---------------------------------------------------
    def to_public(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "avatar": self.avatar_public(),
        }

    def __repr__(self) -> str:  # pragma: no cover - удобство отладки
        return f"<User {self.username!r}>"


class Room(db.Model):
    """Комната = пара каналов: текстовый и голосовой.

    Имена каналов считаются производными: ``text-{slug}`` / ``voice-{slug}``,
    отдельной таблицы каналов нет — по ТЗ у комнаты ровно по одному каналу.
    """

    __tablename__ = "rooms"

    id = db.Column(db.Integer, primary_key=True)
    slug = db.Column(db.String(32), unique=True, nullable=False, index=True)
    name_key = db.Column(db.String(64), nullable=False)
    text_key = db.Column(db.String(64), nullable=True)
    voice_key = db.Column(db.String(64), nullable=True)
    position = db.Column(db.Integer, default=0, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    messages = db.relationship(
        "Message", back_populates="room", lazy="dynamic", cascade="all, delete-orphan"
    )

    @property
    def text_channel(self) -> str:
        return f"text-{self.slug}"

    @property
    def voice_channel(self) -> str:
        return f"voice-{self.slug}"

    def to_public(self) -> dict:
        return {
            "id": self.id,
            "slug": self.slug,
            "name_key": self.name_key,
            # Подписи каналов в сайдбаре: категория «Текстовые» и «Голосовые»
            "text_key": self.text_key or f"channel.text_{self.position + 1}",
            "voice_key": self.voice_key or f"channel.voice_{self.position + 1}",
            "text_channel": self.text_channel,
            "voice_channel": self.voice_channel,
            "position": self.position,
        }

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Room {self.slug!r}>"


class Message(db.Model):
    __tablename__ = "messages"

    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    text = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)

    # Ссылка на сообщение, на которое отвечают (reply). Храним id, а не объект:
    # при удалении исходного ответ остаётся с пустой цитатой.
    reply_to_id = db.Column(db.Integer, nullable=True, index=True)

    author = db.relationship("User", back_populates="messages")
    room = db.relationship("Room", back_populates="messages")
    reactions = db.relationship(
        "Reaction", back_populates="message", lazy="selectin", cascade="all, delete-orphan"
    )

    @property
    def links(self) -> list[str]:
        """Ссылки, найденные в тексте (уже нормализованные, с протоколом)."""
        from .links import extract_links

        return extract_links(self.text)

    def to_public(self, reply_previews: dict[int, dict] | None = None) -> dict:
        """Формат, который уходит на клиент в ``text_message``.

        Включает аватарку автора: иначе в чужой ленте картинка не появится —
        клиент не обязан знать всех пользователей заранее.

        ``reply_previews`` — заранее собранные цитаты (см. ``_reply_previews``
        в api.py): так история не делает N+1 запрос к базе.
        """
        preview = (reply_previews or {}).get(self.reply_to_id) if self.reply_to_id else None
        return {
            "id": self.id,
            "room": self.room.slug,
            "user_id": self.user_id,
            "username": self.author.username if self.author else "?",
            "avatar": self.author.avatar_public() if self.author else None,
            "text": self.text,
            "ts": self.created_at.isoformat(timespec="seconds") + "Z",
            "reply_to": preview,
            "links": self.links,
            "reactions": self.reactions_public(),
        }

    def reactions_public(self) -> list[dict]:
        """Реакции в виде ``[{emoji, count, users: [ids]}]``.

        Флаг «моя реакция» на клиенте, потому что одно и то же сообщение
        уходит всем сразу — сервер не знает, кому конкретно отвечает.
        """
        grouped: dict[str, list[int]] = {}
        for reaction in self.reactions:
            grouped.setdefault(reaction.emoji, []).append(reaction.user_id)
        return [
            {"emoji": emoji, "count": len(users), "users": users}
            for emoji, users in sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0]))
        ]

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Message {self.id} room={self.room_id}>"


class Reaction(db.Model):
    """Реакция на сообщение: один пользователь — одна реакция на сообщение.

    Храним эмодзи строкой (набор фиксирован на клиенте), чтобы не заводить
    справочники ради пяти символов.
    """

    __tablename__ = "reactions"
    __table_args__ = (UniqueConstraint("message_id", "user_id", name="uq_reaction_user"),)

    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(
        db.Integer, db.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    emoji = db.Column(db.String(16), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    message = db.relationship("Message", back_populates="reactions")


class RoomMember(db.Model):
    """Кто сейчас находится в текстовом канале комнаты (presence).

    Нужно, чтобы сервер мог не рассылать уведомление тому, у кого комната
    открыта в фокусе — но финальное решение всё равно за клиентом
    (document.hidden проверяется только там).
    """

    __tablename__ = "room_members"
    __table_args__ = (UniqueConstraint("room_id", "user_id", name="uq_room_member"),)

    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    joined_at = db.Column(db.DateTime, default=utcnow, nullable=False)
