"""Тесты аутентификации: регистрация, логин, логаут, профиль."""

from __future__ import annotations


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "service": "botyaratalk"}


def test_register_creates_session(client):
    response = client.post(
        "/api/auth/register",
        json={"username": "kotik", "password": "supersecret", "password2": "supersecret"},
    )
    payload = response.get_json()
    assert response.status_code == 201
    assert payload["ok"] is True
    assert payload["user"]["username"] == "kotik"
    assert "password" not in payload["user"]

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.get_json()["user"]["username"] == "kotik"


def test_register_validates_username_and_password(client):
    short_name = client.post(
        "/api/auth/register",
        json={"username": "ab", "password": "supersecret", "password2": "supersecret"},
    )
    assert short_name.status_code == 400
    assert short_name.get_json()["ok"] is False

    short_password = client.post(
        "/api/auth/register",
        json={"username": "validname", "password": "123", "password2": "123"},
    )
    assert short_password.status_code == 400

    mismatch = client.post(
        "/api/auth/register",
        json={"username": "validname", "password": "supersecret", "password2": "otherpass"},
    )
    assert mismatch.status_code == 400


def test_register_rejects_duplicate_username(client):
    client.post(
        "/api/auth/register",
        json={"username": "dupe", "password": "supersecret", "password2": "supersecret"},
    )
    client.post("/api/auth/logout")
    response = client.post(
        "/api/auth/register",
        json={"username": "DUPE", "password": "supersecret", "password2": "supersecret"},
    )
    assert response.status_code == 409


def test_password_is_hashed_with_pbkdf2(app, client):
    client.post(
        "/api/auth/register",
        json={"username": "hashed", "password": "supersecret", "password2": "supersecret"},
    )
    from app.models import User

    user = User.query.filter_by(username="hashed").first()
    assert user.password_hash.startswith("pbkdf2:sha256")
    assert "supersecret" not in user.password_hash
    assert user.check_password("supersecret")
    assert not user.check_password("wrong")


def test_login_logout_flow(client):
    client.post(
        "/api/auth/register",
        json={"username": "loginuser", "password": "supersecret", "password2": "supersecret"},
    )
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401

    bad = client.post("/api/auth/login", json={"username": "loginuser", "password": "nope"})
    assert bad.status_code == 401

    good = client.post("/api/auth/login", json={"username": "loginuser", "password": "supersecret"})
    assert good.status_code == 200
    assert good.get_json()["user"]["username"] == "loginuser"

    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401


def test_pages_redirect_when_not_authenticated(client):
    # Онбординг не пройден — уводим на визард
    response = client.get("/app")
    assert response.status_code == 302
    assert "/onboarding" in response.headers["Location"]

    client.set_cookie("botyaratalk_onboarded", "1")
    response = client.get("/app")
    assert response.status_code == 302
    assert "/auth" in response.headers["Location"]


def test_onboarding_page_renders(client):
    response = client.get("/onboarding")
    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "data-panel=\"lang\"" in body
    assert "data-panel=\"theme\"" in body
    assert "data-panel=\"register\"" in body
    # Никаких русских строк в разметке — только data-i18n
    assert "Выберите язык" not in body


def test_i18n_endpoint(client):
    ru = client.get("/api/i18n?lang=ru").get_json()
    en = client.get("/api/i18n?lang=en").get_json()
    assert ru["ok"] and en["ok"]
    assert ru["translations"]["auth.login"] != en["translations"]["auth.login"]
    # Ключи совпадают — иначе часть UI останется непереведённой
    assert set(ru["translations"]) == set(en["translations"])
