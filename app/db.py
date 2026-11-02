"""Работа с БД: инициализация, создание схемы, сидирование комнат."""

from __future__ import annotations

from flask import Flask
from sqlalchemy import inspect, text

from .models import Room, db

# Миграции для баз, созданных прошлыми версиями.
# db.create_all() НЕ добавляет колонки в существующую таблицу, поэтому при
# обновлении с 1.0 старая botyaratalk.db осталась бы без reply_to_id и без
# таблицы reactions. Здесь идемпотентный ALTER TABLE — ровно то, что нужно
# SQLite: проверяем наличие и только потом добавляем.
MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    ("messages", "reply_to_id", "ALTER TABLE messages ADD COLUMN reply_to_id INTEGER"),
    ("users", "avatar_kind", "ALTER TABLE users ADD COLUMN avatar_kind VARCHAR(16)"),
    ("users", "avatar_file", "ALTER TABLE users ADD COLUMN avatar_file VARCHAR(64)"),
    ("users", "avatar_seed", "ALTER TABLE users ADD COLUMN avatar_seed VARCHAR(32)"),
    ("users", "avatar_palette", "ALTER TABLE users ADD COLUMN avatar_palette VARCHAR(32)"),
    ("users", "avatar_density", "ALTER TABLE users ADD COLUMN avatar_density INTEGER"),
)


def init_db(app: Flask) -> None:
    """Привязывает db к приложению и создаёт схему при первом запуске."""
    db.init_app(app)
    with app.app_context():
        db.create_all()
        migrate_db()
        seed_rooms(app)


def migrate_db() -> list[str]:
    """Доводит схему старой базы до актуальной. Возвращает список правок."""
    applied: list[str] = []
    inspector = inspect(db.engine)

    for table, column, statement in MIGRATIONS:
        if not inspector.has_table(table):
            continue  # таблицу только что создал create_all()
        existing = {col["name"] for col in inspector.get_columns(table)}
        if column in existing:
            continue
        db.session.execute(text(statement))
        db.session.commit()
        applied.append(f"{table}.{column}")

    # Таблицу reactions создаёт create_all(); отдельно проверяем на всякий
    # случай, что она действительно есть — иначе реакции молча не сохранятся.
    inspector = inspect(db.engine)
    if not inspector.has_table("reactions"):
        from .models import Reaction  # noqa: F401 (нужен для метаданных)

        Reaction.__table__.create(db.engine)
        applied.append("reactions")

    return applied


def get_db():
    """Доступ к сессии SQLAlchemy (совместимо с Flask-SQLAlchemy 3.x)."""
    return db.session


def seed_rooms(app: Flask) -> None:
    """Создаёт 3 комнаты из конфига, если их ещё нет.

    Идемпотентно: повторный запуск не дублирует записи. Вызывается и из
    init_db(), и из scripts/seed_rooms.py.
    """
    created = 0
    for spec in app.config["SEED_ROOMS"]:
        exists = Room.query.filter_by(slug=spec["slug"]).first()
        if exists:
            # Старые базы (до категорий каналов) добираем недостающими ключами
            changed = False
            for field in ("name_key", "text_key", "voice_key"):
                value = spec.get(field)
                if value and getattr(exists, field) != value:
                    setattr(exists, field, value)
                    changed = True
            if changed:
                db.session.commit()
            continue
        db.session.add(
            Room(
                slug=spec["slug"],
                name_key=spec["name_key"],
                text_key=spec.get("text_key"),
                voice_key=spec.get("voice_key"),
                position=spec["position"],
            )
        )
        created += 1
    if created:
        db.session.commit()
    return created
