"""Ссылки в сообщениях: нормализация протокола и безопасный разбор.

Задача — не «сделать ещё один markdown», а аккуратно превратить то, что люди
реально пишут в чате, в кликабельные ссылки:

* `example.com` → `https://example.com` (протокол дописывается);
* `http://…` и `https://…` остаются как есть — второй протокол не появляется;
* `localhost:5000`, `192.168.1.10:8000`, `botyaratalk.local` тоже распознаются:
  это LAN-мессенджер, здесь такие адреса встречаются чаще, чем что-либо ещё;
* адреса в квадратных скобках (`[текст](url)`) и в обратных кавычках не трогаем —
  этим занимается клиентский рендерер markdown.

Модуль намеренно не делает сетевых запросов: заголовки сайтов тянет браузер
(см. `/api/link-preview`), сервер только валидирует URL.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlparse

# Домены первого уровня, которые встречаются в чате чаще всего. Полный список
# IANA не нужен: правило «есть точка и TLD из 2+ букв» плюс это множество.
KNOWN_TLDS = {
    "com", "org", "net", "io", "dev", "ru", "su", "рф", "app", "ai", "me", "co",
    "info", "biz", "xyz", "tech", "site", "online", "store", "blog", "page", "pro",
    "edu", "gov", "mil", "int", "club", "space", "fun", "live", "link", "click",
    "tv", "fm", "cc", "ws", "gg", "sh", "to", "ly", "gl", "be", "de", "fr", "uk",
    "eu", "us", "ca", "au", "jp", "cn", "in", "br", "es", "it", "nl", "pl", "tr",
    "kz", "ua", "by", "am", "ge", "uz", "md", "lv", "lt", "ee", "fi", "se", "no",
    "dk", "cz", "sk", "hu", "ro", "bg", "gr", "pt", "ie", "is", "ch", "at",
    "local", "lan", "internal", "test", "example",
}

# Локальные адреса: их тоже хочется открывать в LAN-мессенджере
LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0"}

# Схемы, которые вообще готовы открывать: только веб. `javascript:` и
# `data:` отбрасываем сразу — это классическая XSS-дыра через «ссылку».
ALLOWED_SCHEMES = {"http", "https"}

# Кусок текста, который «похож на адрес»: без пробелов и кавычек
_URL_RE = re.compile(
    r"""(?xi)
    (?<![@\w.:/-])                                 # не внутри слова и не после «@»
    (?P<url>
        (?:(?:https?|ftp)://)?                     # необязательный протокол
        (?:
            (?:[\w-]+\.)+[\w-]{2,}                 # домен: example.com / a.b.co
            |\d{1,3}(?:\.\d{1,3}){3}               # или голый IPv4
            |localhost                            # localhost без домена
        )
        (?::\d{2,5})?                              # порт
        (?:[/?#][^\s<>"'`\)\]]*)?                  # путь, query, hash
    )
    """,
)


def _looks_local(host: str) -> bool:
    """localhost / приватный IPv4 — то, что точно имеет смысл в LAN."""
    if host in LOCAL_HOSTS:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_private or address.is_loopback


def is_safe_url(url: str) -> bool:
    """Пускаем только http/https и только с хостом."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ALLOWED_SCHEMES:
        return False
    return bool(parsed.netloc)


def normalize_url(raw: str) -> str | None:
    """Приводит «как написали» к нормальному URL или возвращает None.

    * протокол дописывается, если его нет;
    * `http://` и `https://` не дублируются;
    * мусорные схемы (`javascript:`, `mailto:` и т.п.) отбрасываются.
    """
    if not raw:
        return None

    candidate = raw.strip().strip("<>\"'")
    if not candidate:
        return None

    # Явно чужая схема — не наше дело (mailto:, tel:, javascript:)
    scheme_match = re.match(r"^([a-zA-Z][\w+.-]*):", candidate)
    if scheme_match:
        scheme = scheme_match.group(1).lower()
        if scheme not in ALLOWED_SCHEMES:
            return None
    else:
        # Для приватных адресов и localhost по умолчанию http: там обычно
        # живут dev-серверы и панели роутеров. Для обычных доменов — https.
        probe = urlparse(f"https://{candidate}").hostname or ""
        scheme = "http" if _looks_local(probe) else "https"
        candidate = f"{scheme}://{candidate}"

    if not is_safe_url(candidate):
        return None
    return candidate


def _accept(candidate: str) -> bool:
    """Отсеиваем то, что регулярка поймала зря (например, `v1.2.3`, `file.txt`)."""
    parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
    host = parsed.hostname or ""
    if not host:
        return False

    if _looks_local(host):
        return True

    # IPv4 целиком — тоже годится
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass

    if "." not in host:
        return False  # localhost без домена уже обработан выше

    tld = host.rsplit(".", 1)[-1].lower()
    if tld in KNOWN_TLDS:
        return True
    # Неизвестный TLD принимаем, только если явно указан протокол
    return "://" in candidate


def extract_links(text: str) -> list[str]:
    """Все ссылки из текста — нормализованные и без дублей."""
    if not text:
        return []

    found: list[str] = []
    seen: set[str] = set()
    for match in _URL_RE.finditer(text):
        raw = match.group("url")
        if not _accept(raw):
            continue
        url = normalize_url(raw)
        if not url or url in seen:
            continue
        seen.add(url)
        found.append(url)
    return found


def first_link(text: str) -> str | None:
    links = extract_links(text)
    return links[0] if links else None
