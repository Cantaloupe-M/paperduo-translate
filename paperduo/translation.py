"""Context-aware translation using configured OpenAI-compatible LLM models."""
import json
import hashlib
import os
import tempfile
from pathlib import Path

import httpx


class TranslationError(Exception):
    pass


def settings_path():
    return Path(os.getenv("READER_DATA_DIR", Path(__file__).resolve().parent.parent / ".reader-data")) / "llm-settings.json"


def read_model_settings():
    path = settings_path()
    if path.exists():
        return json.loads(path.read_text())
    return {"base_url": os.getenv("TRANSLATION_LLM_BASE_URL", "").strip().rstrip("/"),
            "model": os.getenv("TRANSLATION_LLM_MODEL", "").strip(),
            "models": [value.strip() for value in os.getenv("TRANSLATION_LLM_MODELS", "").split(",") if value.strip()],
            "api_key": os.getenv("TRANSLATION_LLM_API_KEY", "").strip()}


def save_model_settings(settings):
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as target:
            temporary = Path(target.name)
            json.dump(settings, target, ensure_ascii=False)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def configured_models():
    """The default model comes first; additional choices share its endpoint."""
    settings = read_model_settings()
    default = settings["model"]
    choices = settings["models"]
    return list(dict.fromkeys(value.strip() for value in [default, *choices] if value.strip()))


def academic_model_config(model=None):
    settings = read_model_settings()
    base_url = settings["base_url"]
    models = configured_models()
    if model is not None and model not in models:
        raise TranslationError("未配置该翻译模型")
    if not base_url or not models:
        return None
    return {"base_url": base_url, "model": model or models[0],
            "api_key": settings["api_key"]}


def academic_model_proxy():
    """Use an explicitly configured proxy without inheriting unrelated env vars."""
    return os.getenv("TRANSLATION_LLM_PROXY", "").strip() or None


def providers():
    config = academic_model_config()
    return [{"id": "academic-llm", "name": config["model"] if config else "LLM",
             "available": bool(config),
             "description": "按段落上下文翻译，保持术语与引文一致。"}]


def default_provider():
    return "academic-llm"


def cache_namespace(provider, model=None):
    """Avoid reusing a translation after its model or terminology changed."""
    config = academic_model_config(model)
    if not config:
        return provider
    fingerprint = "\0".join((config["base_url"], config["model"],
                               os.getenv("TRANSLATION_GLOSSARY", "").strip()))
    return "academic-llm:" + hashlib.sha256(fingerprint.encode()).hexdigest()[:16]


def _parse_model_translations(content, expected_ids):
    """Extract and validate the strict JSON object requested from the model."""
    if not isinstance(content, str):
        raise TranslationError("学术模型返回了无法识别的内容")
    value = content.strip()
    if value.startswith("```"):
        value = value.split("\n", 1)[1] if "\n" in value else ""
        if value.rstrip().endswith("```"):
            value = value.rstrip()[:-3].rstrip()
    try:
        start, end = value.index("{"), value.rindex("}") + 1
        translated = json.loads(value[start:end])
    except (ValueError, json.JSONDecodeError):
        raise TranslationError("学术模型未按要求返回可对应原文的译文") from None
    if (not isinstance(translated, dict) or set(translated) != set(expected_ids)
            or any(not isinstance(translated[key], str) or not translated[key].strip()
                   for key in expected_ids)):
        raise TranslationError("学术模型返回的译文与原文片段无法一一对应")
    return {key: translated[key].strip() for key in expected_ids}


async def translate_segments(provider, segments, model=None):
    """Translate ``[{id, source}, ...]`` while retaining their shared context."""
    if provider != "academic-llm":
        raise TranslationError("当前不支持该翻译服务")
    config = academic_model_config(model)
    if not config:
        raise TranslationError("尚未配置学术翻译模型")
    ids = [segment["id"] for segment in segments]
    source = json.dumps(segments, ensure_ascii=False)
    glossary = os.getenv("TRANSLATION_GLOSSARY", "").strip()
    glossary_note = f"\n术语表（必须遵守）：{glossary}" if glossary else ""
    system = (
        "You are an expert English-to-Simplified-Chinese academic translator. "
        "Translate faithfully into fluent formal Chinese. Keep all citation markers, "
        "equation symbols, variable names, acronyms, units, and numbers unchanged. "
        "Use the surrounding segments as paragraph context so pronouns and terminology "
        "remain consistent. Return only a JSON object: every input id must be an exact key "
        "and its value must be that segment's Chinese translation. Do not add Markdown or explanation."
        + glossary_note
    )
    headers = {"Content-Type": "application/json"}
    if config["api_key"]:
        headers["Authorization"] = f"Bearer {config['api_key']}"
    payload = {"model": config["model"], "temperature": 0.1,
               "messages": [{"role": "system", "content": system},
                            {"role": "user", "content": source}]}
    try:
        async with httpx.AsyncClient(trust_env=False, proxy=academic_model_proxy(),
                                     timeout=httpx.Timeout(120, connect=10)) as client:
            response = await client.post(config["base_url"] + "/chat/completions",
                                         headers=headers, json=payload)
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return _parse_model_translations(content, ids)
    except httpx.HTTPStatusError as error:
        if error.response.status_code in (401, 403):
            raise TranslationError("学术模型拒绝访问，请检查 API 密钥") from None
        if error.response.status_code == 429:
            raise TranslationError("学术模型当前繁忙，请稍后重试") from None
        raise TranslationError("学术模型暂不可用，请稍后重试") from None
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError):
        raise TranslationError("无法连接或读取学术翻译模型的响应") from None
