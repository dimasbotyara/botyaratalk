"""HTTPS для LAN: самоподписанный сертификат создаётся сам, без ручных шагов.

Зачем это нужно: браузеры отдают `getUserMedia` / `getDisplayMedia` только в
«безопасном контексте» — по `https://` или на `localhost`. По голому `http://`
с адресом вида `192.168.x.x` камера и микрофон просто не запускаются.

Здесь три задачи:

1. понять, какие адреса писать в сертификат (все локальные IPv4 + localhost);
2. сгенерировать самоподписанный сертификат в `instance/`, если его ещё нет;
3. собрать `ssl.SSLContext` для `socketio.run()`.

Генерация идёт двумя путями: через пакет `cryptography` (основной, ставится из
`requirements.txt`) и, если его нет, через системный `openssl` (запасной).
Оба варианта дают сертификат с корректным `subjectAltName`, иначе Chromium
отказывается открывать страницу даже после «Proceed anyway».
"""

from __future__ import annotations

import ipaddress
import os
import shutil
import socket
import ssl
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Срок жизни сертификата: год — достаточно, перегенерация не нужна
CERT_DAYS = 365


def _log(message: str) -> None:
    print(f"[botyaratalk] {message}")


def local_ip_addresses() -> list[str]:
    """Все IPv4-адреса машины в локальной сети (плюс loopback).

    Способ без внешних запросов: UDP-сокет «подключается» к несуществующему
    адресу — ядро просто выбирает исходящий интерфейс, пакет никуда не уходит.
    """
    addresses: set[str] = {"127.0.0.1"}

    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            addresses.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addresses.add(info[4][0])
    except OSError:
        pass

    return sorted(addresses)


def _san_entries(addresses: list[str]) -> list[str]:
    """Список SAN: IP-адреса + имена, по которым к серверу будут приходить."""
    entries = ["DNS:localhost", "DNS:botyaratalk.local"]
    for address in addresses:
        try:
            ipaddress.ip_address(address)
        except ValueError:
            entries.append(f"DNS:{address}")
        else:
            entries.append(f"IP:{address}")
    return entries


# --------------------------------------------------------------- генерация
def _generate_with_cryptography(cert_file: Path, key_file: Path, addresses: list[str]) -> bool:
    """Основной путь: пакет cryptography (без внешних бинарников)."""
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        return False

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "botyaratalk"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "botyaratalk"),
        ]
    )

    alt_names: list[x509.GeneralName] = []
    for entry in _san_entries(addresses):
        value = entry.split(":", 1)[1]
        if entry.startswith("IP:"):
            alt_names.append(x509.IPAddress(ipaddress.ip_address(value)))
        else:
            alt_names.append(x509.DNSName(value))

    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=CERT_DAYS))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    key_file.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_file.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return True


def _generate_with_openssl(cert_file: Path, key_file: Path, addresses: list[str]) -> bool:
    """Запасной путь: системный openssl (есть в Linux/macOS, в Windows — Git for Windows)."""
    binary = shutil.which("openssl")
    if not binary:
        return False

    subject_alt = ",".join(_san_entries(addresses))
    command = [
        binary,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        str(key_file),
        "-out",
        str(cert_file),
        "-days",
        str(CERT_DAYS),
        "-nodes",
        "-subj",
        "/CN=botyaratalk",
        "-addext",
        f"subjectAltName={subject_alt}",
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, OSError):
        return False
    return True


def ensure_certificate(cert_file: Path, key_file: Path) -> bool:
    """Гарантирует наличие пары cert/key. True — файлы готовы к использованию."""
    if cert_file.exists() and key_file.exists():
        return True

    addresses = local_ip_addresses()
    _log(f"HTTPS: сертификат создаётся для {', '.join(addresses)}")

    cert_file.parent.mkdir(parents=True, exist_ok=True)
    generated = _generate_with_cryptography(cert_file, key_file, addresses) or _generate_with_openssl(
        cert_file, key_file, addresses
    )
    if not generated:
        _log("HTTPS: не удалось создать сертификат (нет ни cryptography, ни openssl)")
        return False

    # Приватный ключ не должен быть доступен другим пользователям системы
    try:
        os.chmod(key_file, 0o600)
    except OSError:
        pass

    _log(f"HTTPS: сертификат готов — {cert_file.name}, {key_file.name} (на {CERT_DAYS} дней)")
    return True


# ------------------------------------------------------------------ запуск
def build_ssl_context() -> ssl.SSLContext | None:
    """Возвращает SSLContext для socketio.run() или None, если HTTPS выключен.

    Режим задаётся переменной ``BOTYARATALK_HTTPS``:

    * ``auto`` (по умолчанию) — HTTPS включается, сертификат создаётся сам;
      если создать не удалось, сервер честно падает обратно на HTTP с подсказкой;
    * ``0`` / ``off`` — обычный HTTP (быстрый локальный запуск на localhost);
    * ``1`` / ``on`` — HTTPS обязателен: без сертификата запуск прекращается.
    """
    mode = os.environ.get("BOTYARATALK_HTTPS", "auto").strip().lower()
    if mode in {"0", "off", "false", "no"}:
        return None

    from config import Config  # локальный импорт: модуль не тянет конфиг при импорте

    cert_file = Path(Config.HTTPS_CERT_FILE)
    key_file = Path(Config.HTTPS_KEY_FILE)

    if not ensure_certificate(cert_file, key_file):
        if mode in {"1", "on", "true", "yes"}:
            raise SystemExit(
                "botyaratalk: HTTPS включён принудительно, но сертификат создать не удалось. "
                "Установите пакет cryptography или системный openssl."
            )
        _log("HTTPS недоступен — продолжаю по HTTP (медиа в LAN работать не будут)")
        return None

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert_file), keyfile=str(key_file))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def https_urls(host: str, port: int) -> list[str]:
    """Адреса, по которым сервер будет доступен после запуска (для подсказки)."""
    addresses = local_ip_addresses()
    if host not in {"0.0.0.0", "::", ""}:
        addresses = [host]
    return [f"https://{'localhost' if address == '127.0.0.1' else address}:{port}" for address in addresses]
