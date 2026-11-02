"""Работа с БД: инициализация, создание схемы, сидирование комнат."""

from __future__ import annotations

from flask import Flask

from .models import Room, db


def init_db(app: Flask) -> None:
    """Привязывает db к приложению и создаёт схему при первом запуске."""
    db.init_app(app)
    with app.app_context():
        db.create_all()
        seed_rooms(app)


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
