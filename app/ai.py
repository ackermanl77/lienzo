"""Funciones de IA con un modelo local, a través de cualquier servidor compatible
con la API de OpenAI que corra en esta PC: Ollama (http://127.0.0.1:11434/v1),
LM Studio (http://127.0.0.1:1234/v1) o el servidor de llama.cpp.

Solo se aceptan direcciones de esta máquina (127.0.0.1, localhost, ::1): el
texto del usuario nunca sale de la PC. Funciones:

- ``write``: escribir un texto nuevo a partir de una instrucción;
- ``rewrite``: reescribir un texto (más corto, más largo, formal, divertido,
  corregir, traducir);
- ``magic_design``: pedir al modelo los textos y el estilo de un diseño y
  armar la página con ``templates.magic_page``.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from . import store, templates

TIMEOUT = 240
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")

REWRITE_MODES = {
    "shorter": "Make it noticeably shorter while keeping the key message.",
    "longer": "Make it longer and richer, adding one or two supporting details.",
    "formal": "Rewrite it in a formal, professional tone.",
    "fun": "Rewrite it in a fun, upbeat, playful tone.",
    "fix": "Fix spelling, grammar and punctuation without changing the meaning or tone.",
    "en": "Translate it into English.",
    "es": "Translate it into Spanish.",
}
STYLES = ("audaz", "elegante", "minimalista", "divertido")


class AIError(ValueError):
    """Un problema con el servidor de IA (el mensaje es para el usuario)."""


def check_url(url: Any) -> str:
    url = str(url or "").strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in LOCAL_HOSTS:
        raise AIError("La dirección debe ser un servidor de esta PC (http://127.0.0.1:puerto/v1).")
    return url


def settings() -> Dict[str, str]:
    data = store.load_settings()
    return {"url": data.get("ai_url", ""), "model": data.get("ai_model", "")}


def save_settings(url: Any, model: Any) -> Dict[str, str]:
    model = str(model or "").strip()[:200]
    store.save_settings({"ai_url": check_url(url), "ai_model": model})
    return settings()


def _request(url: str, payload: Optional[Dict[str, Any]] = None, timeout: float = TIMEOUT) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                     method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read(10_000_000).decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read(2000).decode("utf-8", "replace")
        raise AIError(f"El servidor de IA respondió con el error {exc.code}: {detail[:300]}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AIError("No hay un servidor de IA en esa dirección. Abre Ollama o LM Studio y carga un modelo.") from None
    except ValueError:
        raise AIError("El servidor de IA devolvió una respuesta inválida.") from None
    if not isinstance(body, dict):
        raise AIError("El servidor de IA devolvió una respuesta inválida.")
    return body


def status() -> Dict[str, Any]:
    current = settings()
    result: Dict[str, Any] = {**current, "ok": False, "models": [], "error": ""}
    try:
        body = _request(f"{check_url(current['url'])}/models", timeout=5)
        result["models"] = [str(m.get("id")) for m in body.get("data", []) if isinstance(m, dict) and m.get("id")]
        result["ok"] = True
    except AIError as exc:
        result["error"] = str(exc)
    return result


def chat(messages: List[Dict[str, str]], max_tokens: int = 600, temperature: float = 0.8) -> str:
    current = settings()
    url = check_url(current["url"])
    model = current["model"]
    if not model:
        current_status = status()
        if not current_status["ok"]:
            raise AIError(current_status["error"])
        models = current_status["models"]
        if not models:
            raise AIError("Elige un modelo en el panel de IA (el servidor no informó ninguno).")
        model = models[0]
    body = _request(f"{url}/chat/completions", {"model": model, "messages": messages, "max_tokens": max_tokens,
                                                "temperature": temperature, "stream": False})
    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise AIError("El servidor de IA no devolvió texto.") from None
    # Algunos modelos "razonan" entre <think>...</think> antes de responder.
    text = re.sub(r"<think>.*?</think>", "", str(text), flags=re.S).strip()
    if not text:
        raise AIError("El modelo devolvió una respuesta vacía.")
    return text


def _clean(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^(here is|here's|aquí (está|tienes)|claro)[^:\n]*:\s*", "", text, flags=re.I)
    if len(text) > 1 and text[0] in "\"“«" and text[-1] in "\"”»":
        text = text[1:-1].strip()
    return text[:4000]


SYSTEM = ("You write short marketing and design copy for graphic designs (posts, posters, slides). "
          "Answer with the requested text only: no preamble, no quotes, no notes, no markdown.")


def write(instruction: Any, language: str = "es") -> str:
    instruction = " ".join(str(instruction or "").split())[:1000]
    if not instruction:
        raise AIError("Escribe qué quieres que redacte la IA.")
    lang = "Spanish" if language == "es" else "English"
    return _clean(chat([{"role": "system", "content": SYSTEM},
                        {"role": "user", "content": f"Write in {lang}: {instruction}"}]))


def rewrite(text: Any, mode: str) -> str:
    text = str(text or "").strip()[:4000]
    if not text:
        raise AIError("El texto está vacío.")
    if mode not in REWRITE_MODES:
        raise AIError("Modo de reescritura desconocido.")
    keep = "" if mode in ("en", "es") else " Keep the same language as the original."
    return _clean(chat([{"role": "system", "content": SYSTEM},
                        {"role": "user", "content": f"{REWRITE_MODES[mode]}{keep}\n\nTEXT:\n{text}"}], temperature=0.6))


def _json_object(text: str) -> Dict[str, Any]:
    match = re.search(r"\{.*\}", text, flags=re.S)
    if not match:
        raise AIError("El modelo no devolvió el diseño en el formato esperado. Intenta de nuevo.")
    try:
        data = json.loads(match.group(0))
    except ValueError:
        raise AIError("El modelo no devolvió el diseño en el formato esperado. Intenta de nuevo.") from None
    if not isinstance(data, dict):
        raise AIError("El modelo no devolvió el diseño en el formato esperado.")
    return data


def magic_design(description: Any, width: int, height: int, style: str = "", language: str = "es") -> Dict[str, Any]:
    """Una página nueva: la IA propone los textos, el estilo y los colores."""
    description = " ".join(str(description or "").split())[:800]
    if not description:
        raise AIError("Describe el diseño que quieres.")
    lang = "Spanish" if language == "es" else "English"
    prompt = (
        f"Create the copy for a graphic design about: {description}\n"
        f"Write all texts in {lang}. Reply with ONLY a JSON object with these keys:\n"
        '{"title": "3-6 words", "subtitle": "one short sentence", "body": "one or two short sentences or empty", '
        '"cta": "2-3 word call to action or empty", "style": "audaz|elegante|minimalista|divertido", '
        '"background": "#rrggbb", "accent": "#rrggbb", "text": "#rrggbb"}\n'
        "Choose colors with strong contrast between background and text.")
    data = _json_object(chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
                             max_tokens=500, temperature=0.9))
    if style in STYLES:
        data["style"] = style
    return templates.magic_page(width, height, data)
