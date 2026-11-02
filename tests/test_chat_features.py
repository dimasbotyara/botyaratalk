"""Ссылки, ответы на сообщения и реакции."""

from __future__ import annotations

import pytest

from app.links import extract_links, normalize_url


# --------------------------------------------------------------- ссылки
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("example.com", ["https://example.com"]),
        ("https://ya.ru", ["https://ya.ru"]),
        ("http://ya.ru", ["http://ya.ru"]),
        ("смотри example.com и https://ya.ru", ["https://example.com", "https://ya.ru"]),
        ("http://localhost:5000/app", ["http://localhost:5000/app"]),
        ("192.168.1.10:8000/dashboard", ["http://192.168.1.10:8000/dashboard"]),
        ("просто текст без ссылок", []),
        ("versия v1.2.3 и файл file.txt", []),
        ("javascript:alert(1)", []),
        ("mailto:a@b.ru", []),
        ("пиши на почту user@mail.ru", []),
    ],
)
def test_extract_links(text, expected):
    assert extract_links(text) == expected


def test_normalize_url_adds_scheme_only_once():
    assert normalize_url("example.com") == "https://example.com"
    assert normalize_url("http://example.com") == "http://example.com"
    assert normalize_url("https://example.com") == "https://example.com"
    assert normalize_url("javascript:alert(1)") is None


# --------------------------------------------------------- ответы и реакции
def test_reply_and_reactions_roundtrip(app, socket_authed):
    client, user = socket_authed()
    client.emit("join_room", {"room": "channel-1"})
    client.get_received()

    client.emit("text_message", {"room": "channel-1", "text": "первое сообщение"})
    first = [p for p in client.get_received() if p["name"] == "text_message"][0]["args"][0]

    client.emit("text_message", {"room": "channel-1", "text": "это ответ", "reply_to": first["id"]})
    events = client.get_received()
    reply = [p for p in events if p["name"] == "text_message"][0]["args"][0]

    assert reply["reply_to"]["id"] == first["id"]
    assert reply["reply_to"]["text"] == "первое сообщение"
    assert reply["reactions"] == []

    # Ставим реакцию
    client.emit("reaction", {"room": "channel-1", "message_id": reply["id"], "emoji": "👍"})
    events = client.get_received()
    reactions = [p for p in events if p["name"] == "message_reactions"][0]["args"][0]
    assert reactions["reactions"] == [{"emoji": "👍", "count": 1, "users": [user["id"]]}]

    # Повторный клик снимает реакцию
    client.emit("reaction", {"room": "channel-1", "message_id": reply["id"], "emoji": "👍"})
    events = client.get_received()
    reactions = [p for p in events if p["name"] == "message_reactions"][0]["args"][0]
    assert reactions["reactions"] == []


def test_reply_to_message_from_other_room_is_ignored(app, socket_authed):
    client, _ = socket_authed()
    client.emit("join_room", {"room": "channel-1"})
    client.get_received()
    client.emit("text_message", {"room": "channel-1", "text": "в первом канале"})
    first = [p for p in client.get_received() if p["name"] == "text_message"][0]["args"][0]

    client.emit("join_room", {"room": "channel-2"})
    client.get_received()
    client.emit("text_message", {"room": "channel-2", "text": "ответ из другого", "reply_to": first["id"]})
    reply = [p for p in client.get_received() if p["name"] == "text_message"][0]["args"][0]
    assert reply["reply_to"] is None


def test_history_contains_links_and_reactions(client, app, socket_authed):
    sio_client, _ = socket_authed()
    sio_client.emit("join_room", {"room": "channel-1"})
    sio_client.get_received()
    sio_client.emit("text_message", {"room": "channel-1", "text": "зайди на example.com"})
    message = [p for p in sio_client.get_received() if p["name"] == "text_message"][0]["args"][0]
    sio_client.emit("reaction", {"room": "channel-1", "message_id": message["id"], "emoji": "🔥"})
    sio_client.get_received()

    response = client.get("/api/rooms/channel-1/messages")
    payload = response.get_json()
    stored = [m for m in payload["messages"] if m["id"] == message["id"]][0]
    assert stored["links"] == ["https://example.com"]
    assert stored["reactions"][0]["emoji"] == "🔥"


# ------------------------------------------------------------- аватарки
def test_avatar_generator_is_deterministic():
    from app.avatar import pixel_grid, render_svg

    first = pixel_grid("hello", 30)
    assert first == pixel_grid("hello", 30)
    assert first != pixel_grid("world", 30)
    assert 250 <= len(first) <= 350  # 30% от 1024

    svg = render_svg("hello", "mocha", 30)
    assert svg.startswith("<svg") and svg.endswith("</svg>")
    assert "shape-rendering" in svg


def test_avatar_density_clamped():
    from app.avatar import normalize_density

    assert normalize_density(999) == 55
    assert normalize_density(-5) == 5
    assert normalize_density("не число") == 30


def test_avatar_upload_rejects_bad_files(client, auth_helper):
    auth_helper("avatar_user")

    # Мусор вместо картинки
    response = client.post(
        "/api/avatar/upload",
        data={"avatar": (__import__("io").BytesIO(b"not an image"), "x.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert response.get_json()["error"] == "bad_format"


def test_avatar_upload_and_reset(client, auth_helper):
    import io
    import struct
    import zlib

    auth_helper("avatar_ok")

    # Минимальный валидный PNG 1×1
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))
        + chunk(b"IEND", b"")
    )

    response = client.post(
        "/api/avatar/upload",
        data={"avatar": (io.BytesIO(png), "a.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200, response.get_json()
    avatar = response.get_json()["avatar"]
    assert avatar["kind"] == "upload"
    assert avatar["url"] == "/api/avatar/avatar_ok"

    # Файл реально отдаётся
    assert client.get("/api/avatar/avatar_ok").status_code == 200

    # Сброс — снова инициалы
    assert client.delete("/api/avatar").get_json()["ok"] is True
    me = client.get("/api/auth/me").get_json()
    assert me["user"]["avatar"]["kind"] is None


def test_avatar_generated_save_and_svg(client, auth_helper):
    auth_helper("gen_user")

    response = client.post(
        "/api/avatar/generated",
        json={"seed": "abcd1234", "palette": "ocean", "density": 40},
    )
    assert response.status_code == 200
    avatar = response.get_json()["avatar"]
    assert avatar["kind"] == "generated"
    assert "seed=abcd1234" in avatar["url"]
    assert "palette=ocean" in avatar["url"]

    svg = client.get("/api/avatar/generated.svg?seed=abcd1234&palette=ocean&density=40")
    assert svg.status_code == 200
    assert svg.mimetype == "image/svg+xml"


def test_avatar_options_endpoint(client, auth_helper):
    auth_helper("options_user")
    payload = client.get("/api/avatar/options").get_json()
    assert payload["ok"] is True
    assert len(payload["palettes"]) == 8
    assert payload["density"]["default"] == 30


# ------------------------------------------------------------- миграции БД
def test_migration_adds_columns_to_old_database(tmp_path):
    """Старая база без reply_to_id и без аватарок должна обновиться сама.

    create_app() → init_db() → migrate_db(): приложение обязано подняться на
    базе предыдущей версии, без «no such column: messages.reply_to_id».
    """
    import sqlite3

    import sqlalchemy as sa

    from app import create_app
    from app.db import migrate_db

    db_file = tmp_path / "old.db"
    raw = sqlite3.connect(db_file)
    raw.executescript(
        """
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            username VARCHAR(32) NOT NULL,
            username_lower VARCHAR(32) NOT NULL,
            password_hash VARCHAR(256) NOT NULL,
            created_at DATETIME,
            last_seen DATETIME
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            room_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at DATETIME
        );
        INSERT INTO messages (room_id, user_id, text) VALUES (1, 1, 'старое сообщение');
        """
    )
    raw.commit()
    raw.close()

    old_app = create_app(
        {
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{db_file}",
            "TESTING": True,
            "SECRET_KEY": "test",
        }
    )

    with old_app.app_context():
        engine = old_app.extensions["sqlalchemy"].engine
        inspector = sa.inspect(engine)

        message_cols = {c["name"] for c in inspector.get_columns("messages")}
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        assert "reply_to_id" in message_cols
        assert {"avatar_kind", "avatar_file", "avatar_seed", "avatar_palette", "avatar_density"} <= user_cols
        assert inspector.has_table("reactions")

        # Старые данные на месте
        assert engine.connect().execute(sa.text("SELECT text FROM messages")).scalar() == "старое сообщение"

        # Идемпотентность: второй прогон ничего не делает
        assert migrate_db() == []
