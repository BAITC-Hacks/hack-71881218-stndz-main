"""Локальные настройки LLM; переменные процесса имеют приоритет над .env."""

import math
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

ENV_FILE = Path(__file__).with_name(".env")


@dataclass(frozen=True)
class LLMSettings:
    base_url: str = "https://api.openai.com/v1"
    api_key: str = field(default="", repr=False)
    model: str = ""
    provider: str = "openai"
    timeout_seconds: float = 30.0

    def __post_init__(self):
        if self.provider not in ("openai", "ollama"):
            raise ValueError("LLM_PROVIDER должен быть openai или ollama")
        if not math.isfinite(self.timeout_seconds) or not 0 < self.timeout_seconds <= 300:
            raise ValueError("LLM_TIMEOUT_SECONDS должен быть больше 0 и не больше 300")

    @classmethod
    def from_env(cls, env_file: Path | None = None):
        values = dotenv_values(env_file if env_file is not None else ENV_FILE, interpolate=False)

        def get(name: str, default: str = "") -> str:
            # Явное пустое значение тоже переопределяет файл (отключение API-ключа).
            return os.environ.get(name, values.get(name) or default).strip()

        provider = get("LLM_PROVIDER", "openai")
        default_url = "http://127.0.0.1:11434/v1" if provider == "ollama" else cls.base_url
        try:
            timeout = float(get("LLM_TIMEOUT_SECONDS", str(cls.timeout_seconds)))
        except ValueError:
            raise ValueError("LLM_TIMEOUT_SECONDS должен быть числом") from None
        return cls(
            base_url=get("LLM_BASE_URL", default_url).rstrip("/"),
            api_key=get("LLM_API_KEY"), model=get("LLM_MODEL"),
            provider=provider, timeout_seconds=timeout,
        )
