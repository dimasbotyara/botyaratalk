"""Тесты статики и «здоровья» проекта: вендоры, локали, безопасность.

Эти проверки не про логику, а про то, что репозиторий можно публиковать:
все ассеты лежат локально, ключевые файлы на месте, секретов в коде нет.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_rnnoise_vendor_assets_exist():
    """RNNoise лежит локально: worklet + обе сборки wasm + лицензия."""
    vendor = ROOT / "static" / "vendor" / "rnnoise"
    expected = {
        "workletProcessor.js": 10_000,
        "rnnoise.wasm": 50_000,
        "rnnoise_simd.wasm": 50_000,
        "LICENSE": 100,
    }
    for name, min_size in expected.items():
        path = vendor / name
        assert path.exists(), f"нет файла {name}"
        assert path.stat().st_size >= min_size, f"{name} подозрительно маленький"

    # wasm начинается с магической сигнатуры \0asm
    assert (vendor / "rnnoise.wasm").read_bytes()[:4] == b"\x00asm"
    assert (vendor / "rnnoise_simd.wasm").read_bytes()[:4] == b"\x00asm"

    worklet = (vendor / "workletProcessor.js").read_text(encoding="utf-8")
    assert "@sapphi-red/web-noise-suppressor/rnnoise" in worklet


def test_no_external_cdn_references():
    """Никаких внешних CDN в шаблонах и статике."""
    patterns = re.compile(r"https?://(?!127\.0\.0\.1|localhost)[\w.-]+\.(?:com|net|org|io|dev)")
    offenders = []
    for folder in ("templates", "static/js", "static/css"):
        for path in (ROOT / folder).rglob("*"):
            if path.is_file() and path.suffix in {".html", ".js", ".css"}:
                text = path.read_text(encoding="utf-8", errors="ignore")
                for match in patterns.finditer(text):
                    # stun:... не попадает под regex, но комментарии-ссылки — да
                    offenders.append(f"{path.relative_to(ROOT)}: {match.group(0)}")
    # Разрешены: служебный STUN-адрес и XML-namespace W3C (не сетевой запрос)
    offenders = [
        item for item in offenders
        if "stun.l.google.com" not in item and "w3.org" not in item
    ]
    assert not offenders, f"внешние ресурсы: {offenders[:5]}"


def test_secret_key_is_not_hardcoded():
    """SECRET_KEY не лежит в коде: он генерируется в instance/secret.key."""
    config = (ROOT / "config.py").read_text(encoding="utf-8")
    assert "secrets.token_hex" in config
    assert 'BOTYARATALK_SECRET_KEY' in config
    # В боевом классе Config нет литерала SECRET_KEY = "…"; в TestConfig
    # намеренно стоит фиксированный ключ — это нормально для тестов.
    production = config.split("class TestConfig")[0]
    assert not re.search(r'SECRET_KEY\s*=\s*"[^"\n]{8,}"', production)

    from config import Config

    assert len(Config.SECRET_KEY) >= 32


def test_gitignore_covers_local_data():
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    for entry in ("instance/", "*.db", "secret.key", "__pycache__/", ".venv/", "node_modules/"):
        assert entry in ignore, f"в .gitignore нет {entry}"


def test_license_is_mit_for_author():
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    assert license_text.startswith("MIT License")
    assert "dimasbotyara" in license_text
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "MIT" in readme


def test_readme_has_badges_and_screenshots():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "img.shields.io/badge" in readme, "нет бейджей"
    assert "screenshots/chat-with-message.png" in readme, "скриншоты не вставлены"
    assert readme.lower().startswith("# botyaratalk")


def test_requirements_pinned_and_dev_split():
    prod = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    dev = (ROOT / "requirements-dev.txt").read_text(encoding="utf-8")
    assert "Flask==" in prod, "прод-зависимости должны быть с точными версиями"
    assert "pytest" not in prod, "pytest не должен тянуться в прод"
    assert "pytest" in dev and "playwright" in dev
    assert "-r requirements.txt" in dev


def test_all_project_files_present():
    """Структура из ТЗ на месте (ключевые файлы)."""
    expected = [
        "run.py",
        "config.py",
        "app/__init__.py",
        "app/models.py",
        "app/db.py",
        "app/auth.py",
        "app/routes.py",
        "app/api.py",
        "app/sockets.py",
        "app/signaling.py",
        "app/i18n.py",
        "app/tls.py",
        "locales/ru.json",
        "locales/en.json",
        "static/js/main.js",
        "static/js/theme.js",
        "static/js/i18n.js",
        "static/js/onboarding.js",
        "static/js/auth.js",
        "static/js/rooms.js",
        "static/js/textchat.js",
        "static/js/voice.js",
        "static/js/screen.js",
        "static/js/settings.js",
        "static/js/notifications.js",
        "static/js/utils.js",
        "static/js/stage.js",
        "static/js/noise.js",
        "static/js/socket.js",
        "templates/base.html",
        "templates/onboarding.html",
        "templates/auth.html",
        "templates/app.html",
        "templates/partials/sidebar.html",
        "templates/partials/chat.html",
        "templates/partials/voice-bar.html",
        "templates/partials/settings-modal.html",
        "scripts/seed_rooms.py",
        "scripts/take_screenshots.py",
        "tests/test_auth.py",
        "tests/test_rooms.py",
        "tests/test_socket_chat.py",
        "README.md",
        "DECISIONS.md",
        "AUDIT.md",
        "LICENSE",
        ".gitignore",
        "Makefile",
    ]
    missing = [path for path in expected if not (ROOT / path).exists()]
    assert not missing, f"нет файлов: {missing}"


def test_locales_have_identical_keys():
    ru = json.loads((ROOT / "locales" / "ru.json").read_text(encoding="utf-8"))
    en = json.loads((ROOT / "locales" / "en.json").read_text(encoding="utf-8"))
    assert set(ru) == set(en), f"рассинхрон ключей: {set(ru) ^ set(en)}"
    # Названия каналов локализованы в обеих локалях
    for key in ("room.channel_1", "room.channel_2", "room.channel_3",
                "channel.text_1", "channel.voice_1",
                "sidebar.category_text", "sidebar.category_voice"):
        assert ru[key] != en[key] or key.startswith("channel."), key


def test_no_hardcoded_russian_in_templates():
    """В шаблонах нет русских строк — только data-i18n."""
    cyrillic = re.compile(r"[А-Яа-яЁё]{3,}")
    offenders = []
    for path in (ROOT / "templates").rglob("*.html"):
        body = path.read_text(encoding="utf-8")
        # Игнорируем jinja-комментарии
        body = re.sub(r"\{#.*?#\}", "", body, flags=re.S)
        for match in cyrillic.finditer(body):
            if match.group(0) in {"Русский"}:
                continue  # название языка на карточке выбора — это данные, не UI-строка
            offenders.append(f"{path.name}: {match.group(0)}")
    assert not offenders, f"русский текст в шаблонах: {offenders[:5]}"


def test_no_inline_styles_in_templates():
    offenders = []
    for path in (ROOT / "templates").rglob("*.html"):
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"<[^>]+\sstyle=", line):
                offenders.append(f"{path.name}:{line_no}")
    assert not offenders, f"inline-стили: {offenders[:5]}"


def test_theme_files_have_required_variables():
    themes_dir = ROOT / "static" / "css" / "themes"
    required = ["--bg:", "--bg-alt:", "--fg:", "--fg-muted:", "--accent:", "--accent-fg:",
                "--border:", "--danger:", "--success:", "--warning:", "--hover:"]
    files = sorted(themes_dir.glob("*.css"))
    assert len(files) == 10, f"ожидалось 10 тем, найдено {len(files)}"
    for path in files:
        css = path.read_text(encoding="utf-8")
        for variable in required:
            assert variable in css, f"{path.name}: нет {variable}"


def test_https_certificate_generation(tmp_path):
    """HTTPS для LAN: сертификат создаётся сам и содержит SAN с IP-адресами."""
    from app.tls import ensure_certificate, local_ip_addresses

    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    assert ensure_certificate(cert, key) is True
    assert cert.exists() and key.exists()

    body = cert.read_text(encoding="utf-8")
    assert "BEGIN CERTIFICATE" in body
    # PKCS#1 («RSA PRIVATE KEY») понимают и openssl, и ssl.load_cert_chain
    assert "PRIVATE KEY" in key.read_text(encoding="utf-8")

    # SAN обязателен: без него Chromium не пустит на https://192.168.x.x
    import ssl

    info = ssl._ssl._test_decode_cert(str(cert))  # noqa: SLF001 (публичного API нет)
    alt_names = [value for entry in info.get("subjectAltName", ()) for value in entry]
    assert "IP Address" in alt_names or "IP" in alt_names
    assert local_ip_addresses()

    # Повторный вызов не перегенерирует файлы (иначе сертификат «мигал» бы)
    fingerprint = cert.read_bytes()
    assert ensure_certificate(cert, key) is True
    assert cert.read_bytes() == fingerprint


def test_run_py_has_no_hardcoded_ssl_paths():
    """run.py не должен содержать жёстко прописанных путей и IP сертификата."""
    run_py = (ROOT / "run.py").read_text(encoding="utf-8")
    assert "ssl_context" in run_py
    assert "cert.pem" not in run_py, "пути к сертификату живут в config.py"
    # 0.0.0.0 — это адрес привязки по умолчанию, а не захардкоженный IP машины
    hardcoded = [
        addr for addr in re.findall(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", run_py)
        if addr != "0.0.0.0"
    ]
    assert not hardcoded, f"в run.py зашит IP: {hardcoded}"
    assert "openssl" not in run_py, "генерация сертификата вынесена в app/tls.py"


def test_gitignore_ignores_certificates_and_notes():
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    for entry in ("*.pem", "AUDIT.md", "DECISIONS.md"):
        assert entry in ignore, f"в .gitignore нет {entry}"


def test_stage_module_and_layout_hooks():
    """Раскладка голосовой зоны: модуль stage.js и его CSS-хуки на месте."""
    stage = (ROOT / "static" / "js" / "stage.js").read_text(encoding="utf-8")
    for symbol in ("applyMode", "setSpotlight", "requestPictureInPicture", "voice:layout-changed"):
        assert symbol in stage, f"в stage.js нет {symbol}"

    css = (ROOT / "static" / "css" / "voice.css").read_text(encoding="utf-8")
    for selector in ('data-voice-layout="pinned"', 'data-voice-layout="stage"', "voice-tile--spotlight"):
        assert selector in css, f"в voice.css нет {selector}"

    template = (ROOT / "templates" / "partials" / "voice-bar.html").read_text(encoding="utf-8")
    # Кнопки панели: закрепить, развернуть, свернуть, заглушить звук, выйти
    for element_id in ("voice-pin", "voice-fullscreen", "voice-exit-fullscreen", "btn-deafen", "btn-leave"):
        assert f'id="{element_id}"' in template, f"нет кнопки {element_id}"


def test_default_port_is_documented_everywhere():
    """Порт по умолчанию задаётся в одном месте и совпадает с документацией.

    Раньше 5000 было вписано в run.py, README, AUDIT и Makefile — при смене
    порта легко забыть один из файлов и получить «запускаюсь не туда».
    """
    from config import DEFAULT_PORT

    assert DEFAULT_PORT == 14098

    run_py = (ROOT / "run.py").read_text(encoding="utf-8")
    assert "DEFAULT_PORT" in run_py, "run.py должен брать порт из config.py"
    assert "5000" not in run_py, "в run.py остался старый порт 5000"

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert f"BOTYARATALK_PORT` | `{DEFAULT_PORT}`" in readme, "порт в таблице README"
    assert f":{DEFAULT_PORT}" in readme, "порт в примерах README"
    assert ":5000" not in readme, "в README остался старый порт 5000"

    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert str(DEFAULT_PORT) in makefile, "порт в подсказке Makefile"
