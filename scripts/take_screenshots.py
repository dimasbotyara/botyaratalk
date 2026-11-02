#!/usr/bin/env python3
"""Playwright-скриншоты botyaratalk.

Скрипт самодостаточный и идемпотентный:
  1. чистит screenshots/ и тестовую БД в instance/;
  2. поднимает Flask на свободном порту (async_mode=threading, без gevent);
  3. регистрирует screenshot_user через онбординг;
  4. снимает 10 экранов в 1280×800.

Запуск:
    python scripts/take_screenshots.py
    # или
    make screenshots

Требуется: pip install playwright && playwright install chromium
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCREENSHOTS = ROOT / "screenshots"
sys.path.insert(0, str(ROOT))

VIEWPORT = {"width": 1280, "height": 800}
CHROMIUM_ARGS = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--allow-running-insecure-content",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    # Автовыбор источника для getDisplayMedia (иначе headless молча падает)
    "--auto-select-desktop-capture-source=Entire screen",
    # Звук вкладки в headless: без этого Chromium отдаёт только видео
    "--auto-select-tab-capture-source-by-title=botyaratalk",
    "--allow-http-screen-capture",
]

USERNAME = "screenshot_user"
PASSWORD = "screenshot_pass"


# ---------------------------------------------------------------- инфраструктура
def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_server(url: str, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=1.5) as response:
                if response.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.25)
    return False


def clean_artifacts() -> None:
    if SCREENSHOTS.exists():
        shutil.rmtree(SCREENSHOTS)
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)

    instance = ROOT / "instance"
    instance.mkdir(exist_ok=True)
    for name in ("botyaratalk.db", "botyaratalk.db-wal", "botyaratalk.db-shm", "screenshots.db"):
        path = instance / name
        if path.exists():
            path.unlink()


def start_server(port: int, db_path: Path) -> subprocess.Popen:
    env = {
        **os.environ,
        "BOTYARATALK_PORT": str(port),
        "BOTYARATALK_HOST": "127.0.0.1",
        "BOTYARATALK_ASYNC_MODE": "threading",
        "BOTYARATALK_DB": f"sqlite:///{db_path}",
        "BOTYARATALK_SECRET_KEY": "screenshots-secret",
    }
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "run.py")],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return process


# ------------------------------------------------------------------- сценарии
class Shooter:
    """Обёртка над страницей: settle(), nav(), shoot()."""

    def __init__(self, page, base_url: str):
        self.page = page
        self.base = base_url
        self.shots: list[str] = []

    def goto(self, path: str) -> None:
        self.page.goto(f"{self.base}{path}", wait_until="networkidle")

    def settle(self, ms: int = 350) -> None:
        self.page.wait_for_timeout(ms)

    def shoot(self, name: str, full_page: bool = False) -> Path:
        path = SCREENSHOTS / name
        self.page.screenshot(path=str(path), full_page=full_page)
        self.shots.append(name)
        print(f"  ✓ {name}")
        return path

    # --- онбординг -----------------------------------------------------
    def step_lang(self) -> None:
        self.goto("/onboarding")
        self.settle(500)
        self.shoot("onboarding-step-lang.png")

    def step_theme(self) -> None:
        self.page.click('[data-action="next"][data-from="lang"]')
        self.settle(400)
        # Выбираем Catppuccin Mocha — по умолчанию она и так активна,
        # но клик гарантирует состояние «выбрана» в превью
        card = self.page.locator('[data-theme-card="catppuccin-mocha"]')
        if card.count():
            card.first.click()
            self.settle(200)
        self.shoot("onboarding-step-theme.png")

    def step_register(self) -> None:
        self.page.click('[data-action="next"][data-from="theme"]')
        self.settle(400)
        self.page.fill("#ob-username", USERNAME)
        self.page.fill("#ob-password", PASSWORD)
        self.page.fill("#ob-password2", PASSWORD)
        self.settle(200)
        self.shoot("onboarding-step-register.png")

    def register(self) -> None:
        self.page.click("#ob-submit")
        self.page.wait_for_url(f"{self.base}/app", timeout=15000)
        # Ждём полной инициализации (dataset.ready ставит main.js)
        self.page.wait_for_function("document.body.dataset.ready === 'true'", timeout=15000)
        self.settle(500)

    # --- приложение ----------------------------------------------------
    def set_theme(self, theme: str) -> None:
        self.page.evaluate(
            """(theme) => {
                document.documentElement.setAttribute('data-theme', theme);
                localStorage.setItem('botyaratalk.theme', JSON.stringify(theme));
                document.cookie = `botyaratalk_theme=${theme}; path=/; max-age=31536000`;
            }""",
            theme,
        )
        self.settle(450)

    def open_room(self, slug: str = "channel-1") -> None:
        self.page.click(f'[data-room="{slug}"]')
        self.settle(700)

    def send_message(self, text: str) -> None:
        self.page.fill("#composer-input", text)
        self.page.click("#composer-send")
        self.settle(600)

    def open_settings(self) -> None:
        self.page.click("#open-settings")
        self.page.wait_for_selector("#settings-modal:not([hidden])", timeout=5000)
        self.settle(900)  # даём VU-метру и enumerateDevices время

    def close_settings(self) -> None:
        self.page.click("#close-settings")
        self.settle(300)

    def open_settings_tab(self, tab: str) -> None:
        self.page.click(f'#settings-nav [data-tab="{tab}"]')
        self.settle(400)

    def switch_language(self, lang: str) -> None:
        self.page.click(f'#lang-switch [data-lang-option="{lang}"]')
        self.settle(600)

    def seed_history(self, messages: list[tuple[str, str]]) -> None:
        """Отправляет несколько сообщений, чтобы лента выглядела живой."""
        for author, text in messages:
            self.send_message(text)

    def join_voice(self) -> bool:
        """Пробуем войти в голосовой канал на фейковых медиа-устройствах."""
        try:
            self.page.click("#voice-join")
            self.page.wait_for_selector("#voice-controls:not([hidden])", timeout=10000)
            self.settle(1200)
            return True
        except Exception as error:  # noqa: BLE001 - скриншот важнее падения
            print(f"  ! голосовой канал не открылся: {error}")
            return False


def open_second_peer(browser, base_url: str):
    """Второй браузерный контекст: регистрация + вход в комнату channel-2."""
    try:
        context = browser.new_context(
            viewport=VIEWPORT,
            locale="ru-RU",
            permissions=["microphone", "camera", "notifications"],
        )
        page = context.new_page()
        shooter = Shooter(page, base_url)
        shooter.goto("/onboarding")
        shooter.settle(400)
        page.click('[data-action="next"][data-from="lang"]')
        shooter.settle(250)
        page.click('[data-action="next"][data-from="theme"]')
        shooter.settle(250)
        page.fill("#ob-username", "peer_user")
        page.fill("#ob-password", "peer_pass")
        page.fill("#ob-password2", "peer_pass")
        page.click("#ob-submit")
        page.wait_for_url(f"{base_url}/app", timeout=15000)
        page.wait_for_function("document.body.dataset.ready === 'true'", timeout=15000)
        shooter.settle(400)
        return context, page
    except Exception as error:  # noqa: BLE001 - скриншот важнее падения сценария
        print(f"  ! второй участник не поднялся: {error}")
        return None, None


def run() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright не установлен. Выполните: pip install playwright && playwright install chromium")
        return 2

    clean_artifacts()
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    db_path = Path(tempfile.gettempdir()) / "botyaratalk-screenshots.db"
    if db_path.exists():
        db_path.unlink()

    print(f"→ запускаю botyaratalk на {base_url}")
    server = start_server(port, db_path)
    try:
        if not wait_for_server(base_url):
            print("сервер не поднялся, лог:")
            print(server.stdout.read() if server.stdout else "")
            return 1

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(args=CHROMIUM_ARGS)
            context = browser.new_context(
                viewport=VIEWPORT,
                device_scale_factor=1,
                locale="ru-RU",
                color_scheme="dark",
                permissions=["microphone", "camera", "notifications"],
            )
            page = context.new_page()
            page.on("pageerror", lambda error: print(f"  [js error] {error}"))
            shooter = Shooter(page, base_url)

            print("→ онбординг")
            shooter.step_lang()
            shooter.step_theme()
            shooter.step_register()
            shooter.register()

            print("→ приложение")
            shooter.open_room("channel-1")

            # Светлая Catppuccin Latte
            shooter.set_theme("catppuccin-latte")
            shooter.shoot("app-light-catppuccin-latte.png")

            # Тёмная Gruvbox
            shooter.set_theme("gruvbox-dark")
            shooter.shoot("app-dark-gruvbox.png")

            # Ayu Mirage
            shooter.set_theme("ayu-mirage")
            shooter.shoot("app-ayu-mirage.png")

            # Чат с сообщением
            shooter.set_theme("catppuccin-mocha")
            shooter.send_message("Hello from Playwright")
            shooter.shoot("chat-with-message.png")

            # Настройки: устройства
            shooter.open_settings()
            shooter.shoot("settings-devices.png")

            # Настройки: внешний вид (темы + язык)
            shooter.open_settings_tab("appearance")
            shooter.shoot("settings-appearance.png")

            # Модалка настроек целиком (RNNoise + ползунки)
            shooter.close_settings()
            shooter.open_settings()
            shooter.shoot("settings-modal.png")
            shooter.close_settings()

            # Смена языка без перезагрузки — снимаем английский интерфейс
            shooter.open_settings()
            shooter.open_settings_tab("appearance")
            shooter.switch_language("en")
            shooter.shoot("app-i18n-english.png")
            shooter.switch_language("ru")
            shooter.close_settings()

            # Мобильный вид настроек (768px): /settings сам открывает модалку
            shooter.page.set_viewport_size({"width": 768, "height": 900})
            shooter.goto("/settings?tab=audio")
            shooter.page.wait_for_function("document.body.dataset.ready === 'true'", timeout=15000)
            shooter.page.wait_for_selector("#settings-modal:not([hidden])", timeout=8000)
            shooter.settle(1200)
            shooter.shoot("settings-mobile.png")
            shooter.page.set_viewport_size(VIEWPORT)
            shooter.goto("/app")
            shooter.page.wait_for_function("document.body.dataset.ready === 'true'", timeout=15000)
            shooter.settle(600)

            # Английская локаль целиком (для README)
            shooter.send_message("Nice, the strings switched without reload")
            shooter.settle(400)

            # Голосовой канал (без реального собеседника)
            shooter.open_room("channel-2")
            if shooter.join_voice():
                shooter.shoot("voice-channel.png")
                # Камера включена — живая плитка вместо аватара
                shooter.page.click("#btn-camera")
                shooter.settle(1800)
                shooter.shoot("app-voice-video-on.png")
            else:
                shooter.shoot("voice-channel.png")

            # --- второй собеседник: шаринг экрана с бейджем звука ---
            print("→ второй участник и демонстрация экрана")
            other_context, other_page = open_second_peer(browser, base_url)
            if other_context is not None:
                try:
                    other = Shooter(other_page, base_url)
                    other.open_room("channel-2")
                    other.settle(500)
                    other.join_voice()
                    other.settle(1800)
                    # второй участник включает шаринг экрана (звук системы,
                    # если браузер его отдаёт — тогда появится значок динамика)
                    other_page.click("#btn-screen")
                    other.settle(2600)
                    shooter.settle(1200)
                    shooter.shoot("app-screen-sharing.png")
                finally:
                    other_context.close()

            browser.close()

        print(f"\nготово: {len(shooter.shots)} скриншотов в {SCREENSHOTS}")
        for name in shooter.shots:
            print(f"  - screenshots/{name}")
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    raise SystemExit(run())
