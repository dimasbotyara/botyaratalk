#!/usr/bin/env python3
"""Создаёт базовые комнаты (general / gaming / chill) в БД.

Идемпотентно: повторный запуск не создаёт дубли. Обычно вызывается
автоматически из app.create_app() → init_db(), но можно и руками:

    python scripts/seed_rooms.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Чтобы скрипт работал и из корня проекта, и из scripts/
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app  # noqa: E402
from app.db import seed_rooms  # noqa: E402
from app.models import Room  # noqa: E402


def main() -> int:
    app = create_app()
    with app.app_context():
        created = seed_rooms(app)
        total = Room.query.count()
        print(f"botyaratalk: создано комнат: {created}, всего в базе: {total}")
        for room in Room.query.order_by(Room.position).all():
            print(f"  - {room.slug:<10} text={room.text_channel:<16} voice={room.voice_channel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
