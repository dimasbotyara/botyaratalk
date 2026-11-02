"""Аватарки: загрузка с обрезкой и генеративный пиксельный узор.

Два независимых сценария:

1. **Загрузка файла** (до 2 МБ). Клиент обрезает картинку прямо в браузере
   (canvas) и присылает уже квадрат 256×256 в PNG — сервер только проверяет
   сигнатуру, размер и раскладывает по `instance/avatars/<username>.png`.

2. **Генеративная аватарка**. Пользователь выбирает палитру, процент пикселей
   и сид; сервер рисует сетку 32×32 в SVG. Пиксели чуть темнее фона — это
   и есть «абстрактное искусство» из задачи. Случайность детерминирована:
   один и тот же сид всегда даёт один и тот же узор, поэтому сид можно
   сохранить и поделиться им.

Цвета палитр повторяют темы интерфейса (Catppuccin Mocha и т.п.), поэтому
аватарка не выбивается из оформления.
"""

from __future__ import annotations

import hashlib
import random
import re

# Размер сетки и итогового SVG
GRID = 32
CANVAS = 256

MAX_UPLOAD_BYTES = 2 * 1024 * 1024  # 2 МБ, как в задаче
ALLOWED_SIGNATURES = {
    b"\x89PNG\r\n\x1a\n": "png",
    b"\xff\xd8\xff": "jpeg",
    b"RIFF": "webp",  # дальше проверим «WEBP» на 8-м байте
}

# Палитры: (фон, пиксель) — пиксель заведомо темнее фона
PALETTES: dict[str, dict[str, str]] = {
    "mocha": {"bg": "#cba6f7", "fg": "#8839a8"},      # Catppuccin Mocha, mauve
    "latte": {"bg": "#df8e1d", "fg": "#9a5b06"},      # Catppuccin Latte, peach
    "frappe": {"bg": "#8caaee", "fg": "#3f63b5"},     # синий
    "macchiato": {"bg": "#a6da95", "fg": "#4f8a43"},  # зелёный
    "gruvbox": {"bg": "#d79921", "fg": "#8f5f0a"},    # Gruvbox, жёлтый
    "ayu": {"bg": "#ff8f40", "fg": "#a94f10"},        # Ayu, оранжевый
    "berry": {"bg": "#f5a3c7", "fg": "#a93b6c"},      # розовый
    "ocean": {"bg": "#89dceb", "fg": "#1f7d95"},      # голубой
}

DEFAULT_PALETTE = "mocha"
DEFAULT_DENSITY = 30
MIN_DENSITY = 5
MAX_DENSITY = 55

_SEED_SAFE = re.compile(r"^[\w-]{1,32}$")


def normalize_seed(value: str | None) -> str:
    """Сид: буквы/цифры/дефис до 32 символов. Всё остальное — в хэш."""
    candidate = (value or "").strip()
    if candidate and _SEED_SAFE.match(candidate):
        return candidate
    if not candidate:
        return "botyaratalk"
    digest = hashlib.sha256(candidate.encode("utf-8")).hexdigest()[:12]
    return f"seed-{digest}"


def random_seed() -> str:
    """Человекочитаемый сид для кнопки «перегенерировать»."""
    return "".join(random.choice("abcdefghijkmnpqrstuvwxyz23456789") for _ in range(8))


def normalize_palette(value: str | None) -> str:
    return value if value in PALETTES else DEFAULT_PALETTE


def normalize_density(value: int | str | None) -> int:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_DENSITY
    return max(MIN_DENSITY, min(MAX_DENSITY, number))


def pixel_grid(seed: str, density: int) -> list[tuple[int, int]]:
    """Координаты закрашенных пикселей.

    Случайность привязана к сиду: `random.Random(seed)` даёт стабильную
    последовательность, поэтому узор воспроизводим на любом сервере.
    """
    rng = random.Random(f"botyaratalk:{seed}")
    total = GRID * GRID
    wanted = max(1, round(total * normalize_density(density) / 100))

    cells: set[tuple[int, int]] = set()
    while len(cells) < wanted:
        cells.add((rng.randrange(GRID), rng.randrange(GRID)))
    return sorted(cells)


def render_svg(seed: str, palette: str, density: int) -> str:
    """SVG 32×32 (масштабируется до любого размера) с пиксельным узором."""
    palette_name = normalize_palette(palette)
    colors = PALETTES[palette_name]
    cells = pixel_grid(normalize_seed(seed), normalize_density(density))

    rects = "".join(
        f'<rect x="{x}" y="{y}" width="1" height="1"/>' for x, y in cells
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {GRID} {GRID}" '
        f'shape-rendering="crispEdges" width="{CANVAS}" height="{CANVAS}">'
        f'<rect width="{GRID}" height="{GRID}" fill="{colors["bg"]}"/>'
        f'<g fill="{colors["fg"]}">{rects}</g>'
        "</svg>"
    )


# ------------------------------------------------------------------ загрузка
def sniff_image(data: bytes) -> str | None:
    """Определяет формат по сигнатуре. Расширению из запроса не верим."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def validate_upload(data: bytes) -> tuple[bool, str]:
    """Проверяет размер и формат. Возвращает ``(ок, код_ошибки)``."""
    if not data:
        return False, "empty_file"
    if len(data) > MAX_UPLOAD_BYTES:
        return False, "file_too_large"
    if sniff_image(data) is None:
        return False, "bad_format"
    return True, ""


def is_png(data: bytes) -> bool:
    return data.startswith(b"\x89PNG\r\n\x1a\n")
