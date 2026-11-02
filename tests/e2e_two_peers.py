#!/usr/bin/env python3
"""E2E-проверка WebRTC двумя браузерными контекстами (нужен Playwright).

Скрипт не входит в pytest-набор (он поднимает реальный сервер и браузер),
запускается вручную:

    python tests/e2e_two_peers.py

Проверяет: двусторонний звук, камеру, mute-бейдж, демонстрацию экрана,
остановку шаринга и выход из канала. Печатает отчёт и возвращает код 0/1.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

PORT = int(os.environ.get("BOTYARATALK_E2E_PORT", "5477"))
BASE = f"http://127.0.0.1:{PORT}"
FLAGS = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--allow-running-insecure-content",
    "--autoplay-policy=no-user-gesture-required",
    "--auto-select-desktop-capture-source=Entire screen",
    "--no-sandbox",
]

failures: list[str] = []
CHECKS_PASSED = [0]  # счётчик успешных проверок для итоговой строки


def check(label: str, condition: bool, extra: str = "") -> None:
    mark = "✓" if condition else "✗"
    print(f"  {mark} {label}{(' — ' + extra) if extra else ''}")
    if condition:
        CHECKS_PASSED[0] += 1
    else:
        failures.append(label)


def start_server() -> tuple[subprocess.Popen, Path]:
    db_path = Path(tempfile.gettempdir()) / "botyaratalk-e2e.db"
    if db_path.exists():
        db_path.unlink()
    env = {
        **os.environ,
        "BOTYARATALK_PORT": str(PORT),
        "BOTYARATALK_HOST": "127.0.0.1",
        "BOTYARATALK_SECRET_KEY": "e2e-secret",
        "BOTYARATALK_DB": f"sqlite:///{db_path}",
        # E2E ходит по http://127.0.0.1 — HTTPS для этих прогонов не нужен
        "BOTYARATALK_HTTPS": "0",
    }
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "run.py")],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    for _ in range(80):
        try:
            if urllib.request.urlopen(f"{BASE}/api/health", timeout=1).status == 200:
                return process, db_path
        except Exception:  # noqa: BLE001 - сервер ещё поднимается
            time.sleep(0.25)
    raise RuntimeError("сервер не поднялся")


def register(context, username: str):
    page = context.new_page()
    page.goto(f"{BASE}/onboarding", wait_until="networkidle")
    page.click('[data-action="next"][data-from="lang"]')
    page.wait_for_timeout(150)
    page.click('[data-action="next"][data-from="theme"]')
    page.wait_for_timeout(150)
    page.fill("#ob-username", username)
    page.fill("#ob-password", "secret123")
    page.fill("#ob-password2", "secret123")
    page.click("#ob-submit")
    page.wait_for_url(f"{BASE}/app", timeout=15000)
    page.wait_for_function("document.body.dataset.ready === 'true'", timeout=15000)
    page.click('[data-room="channel-1"]')
    page.wait_for_timeout(400)
    return page


def snapshot(page) -> dict:
    return page.evaluate("window.botyaratalk.voice.snapshot()")


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright не установлен: pip install playwright && playwright install chromium")
        return 2

    server, db_path = start_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(args=FLAGS)
            try:
                alice = register(
                    browser.new_context(viewport={"width": 1280, "height": 800},
                                        permissions=["microphone", "camera"]),
                    "alice_e2e",
                )
                bob = register(
                    browser.new_context(viewport={"width": 1280, "height": 800},
                                        permissions=["microphone", "camera"]),
                    "bob_e2e",
                )

                print("\n[1] голосовой канал")
                alice.click("#voice-join")
                alice.wait_for_timeout(1200)
                bob.click("#voice-join")
                bob.wait_for_timeout(3500)

                sa, sb = snapshot(alice), snapshot(bob)
                check("Alice в канале", sa["joined"])
                check("Bob в канале", sb["joined"])
                check(
                    "двусторонний звук",
                    sa["peers"][0]["inboundAudio"] == "live" and sb["peers"][0]["inboundAudio"] == "live",
                    f"alice→{sa['peers'][0]['inboundAudio']}, bob→{sb['peers'][0]['inboundAudio']}",
                )
                check("ICE connected", sa["peers"][0]["ice"] == "connected")

                print("\n[2] видео")
                bob.click("#btn-camera")
                bob.wait_for_timeout(2500)
                sa = snapshot(alice)
                check("Alice получает камеру Bob", sa["peers"][0]["inboundCamera"] == "live")
                check(
                    "видео-элемент привязан",
                    alice.evaluate(
                        "!!document.querySelector('.voice-tile[data-tile=\"2\"] video')?.srcObject"
                    ),
                )

                print("\n[3] mute")
                alice.click("#btn-mute")
                alice.wait_for_timeout(800)
                check("Bob видит mute Alice", snapshot(bob)["peers"][0]["muted"])
                check(
                    "бейдж микрофона на плитке",
                    bob.evaluate(
                        "!!document.querySelector('.voice-tile[data-tile=\"1\"] .voice-tile__badge--muted')"
                    ),
                )
                alice.click("#btn-mute")
                alice.wait_for_timeout(400)

                print("\n[4] демонстрация экрана (видео + звук)")
                bob.click("#btn-screen")
                bob.wait_for_timeout(3500)
                sa = snapshot(alice)
                check("Bob шарит экран", snapshot(bob)["screenOn"])
                check("Alice получает видеотрек экрана", sa["peers"][0]["inboundScreen"] == "live")
                check("флаг sharing доехал", sa["peers"][0]["sharing"])
                check(
                    "демонстрация — отдельная плитка (не подменяет камеру)",
                    alice.evaluate(
                        """() => {
                            const tiles = [...document.querySelectorAll('.voice-tile')];
                            const screen = tiles.filter((t) => t.dataset.kind === 'screen');
                            const camera = tiles.filter((t) => t.dataset.tile === '2');
                            return screen.length === 1 && camera.length === 1
                                && !screen[0].querySelector('video').hidden
                                && !camera[0].querySelector('video').hidden;
                        }"""
                    ),
                )
                check(
                    "бейдж «Демонстрация экрана» на плитке экрана",
                    alice.evaluate(
                        "!!document.querySelector('.voice-tile[data-tile=\"2-screen\"] .voice-tile__badge--sharing')"
                    ),
                )

                # --- звук шаринга: второй входящий трек + getStats() ---
                screen_state = alice.evaluate(
                    """() => {
                        const st = window.botyaratalk.voice.snapshot();
                        return st.screenAudio[0] || null;
                    }"""
                )
                check("Alice получила аудио-трек шаринга", bool(screen_state and screen_state.get("hasScreenAudioTrack")))

                stats = alice.evaluate(
                    """async () => {
                        const peer = window.botyaratalk.voice.__peerForStats();
                        if (!peer) return null;
                        const report = await peer.getStats();
                        const audio = [];
                        report.forEach((entry) => {
                            if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
                                audio.push({
                                    mid: entry.mid,
                                    bytesReceived: entry.bytesReceived || 0,
                                    packetsReceived: entry.packetsReceived || 0,
                                    totalAudioEnergy: entry.totalAudioEnergy || 0,
                                });
                            }
                        });
                        return audio;
                    }"""
                )
                print(f"    getStats() inbound audio: {json.dumps(stats, ensure_ascii=False)}")
                screen_audio_stats = [s for s in (stats or []) if s["mid"] in ("3", 3)]
                mic_stats = [s for s in (stats or []) if s["mid"] in ("0", 0)]
                check(
                    "getStats: входящее аудио микрофона идёт",
                    bool(mic_stats and mic_stats[0]["bytesReceived"] > 0),
                    f"{mic_stats[0]['bytesReceived'] if mic_stats else 0} байт",
                )
                check(
                    "getStats: входящее аудио экрана идёт (mid=3)",
                    bool(screen_audio_stats and screen_audio_stats[0]["bytesReceived"] > 0),
                    f"{screen_audio_stats[0]['bytesReceived'] if screen_audio_stats else 0} байт",
                )

                # --- раскладка: клик по голосовому каналу и полный экран ---
                print("\n[5] раскладка голосовой зоны")
                title_before = alice.text_content("#room-title")
                alice.click('[data-voice-room="channel-1"]')
                alice.wait_for_timeout(700)
                check(
                    "голосовой канал не переключает текстовый чат",
                    alice.text_content("#room-title") == title_before
                    and alice.evaluate("getComputedStyle(document.querySelector('#chat')).display === 'none'")
                    and snapshot(alice)["layout"] in {"pinned", "stage"},
                )

                alice.click("#voice-fullscreen")
                alice.wait_for_timeout(400)
                check("полный экран включается", snapshot(alice)["layout"] == "stage")

                alice.click('.voice-tile[data-kind="screen"]')
                alice.wait_for_timeout(400)
                check("клик по плитке делает её главной", snapshot(alice)["spotlight"] == "2-screen")

                alice.keyboard.press("Escape")
                alice.wait_for_timeout(300)
                check("Esc сворачивает из полного экрана", snapshot(alice)["layout"] == "pinned")

                # --- «слышать себя»: собеседники не слышат, мы не слышим их ---
                print("\n[6] прослушивание себя в звонке")
                alice.click("#btn-monitor")
                alice.wait_for_timeout(600)
                check("монитор включился", snapshot(alice)["monitorOn"])
                check("Bob видит Alice как выключенную", snapshot(bob)["peers"][0]["muted"])
                alice.click("#btn-monitor")
                alice.wait_for_timeout(600)
                check("монитор выключился", not snapshot(alice)["monitorOn"])

                # --- возврат к текстовому чату ---
                alice.click('[data-room="channel-2"]')
                alice.wait_for_timeout(600)
                check(
                    "клик по текстовому каналу возвращает чат",
                    alice.evaluate(
                        """() => document.querySelector('#app-shell').dataset.voiceLayout === 'normal'
                            && getComputedStyle(document.querySelector('#chat')).display !== 'none'"""
                    ),
                )
                alice.click('[data-room="channel-1"]')
                alice.wait_for_timeout(500)

                print("\n[7] остановка шаринга")
                bob.click("#btn-screen")
                bob.wait_for_timeout(1800)
                check("флаг sharing снят", not snapshot(alice)["peers"][0]["sharing"])

                print("\n[8] выход")
                alice.click("#btn-leave")
                alice.wait_for_timeout(1500)
                check("Alice вышла", not snapshot(alice)["joined"])
                check("у Bob не осталось пиров", len(snapshot(bob)["peers"]) == 0)
            finally:
                browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        if db_path.exists():
            db_path.unlink()

    total = len(failures) + CHECKS_PASSED[0]
    print("\n" + (f"E2E: {total}/{total} проверок зелёные" if not failures
                  else f"E2E: провалов {len(failures)} из {total}: {failures}"))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
