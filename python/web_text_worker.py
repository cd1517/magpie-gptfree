#!/usr/bin/env python3
"""Streaming ChatGPT Web text worker reusing OpenAIWebImageClient session & sentinel auth.

Reads one JSON request payload from stdin and either:
- streams NDJSON events (`delta`, `done`, `error`) to stdout when invoked with `--stream`
  or `payload["stream_events"] is True`, or
- prints a single JSON result object `{ok: True, text, ...}` / `{ok: False, ...}`.
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Optional, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from image_worker import (
    ImageWorkerError,
    OpenAIWebImageClient,
    UpstreamHTTPError,
    _apply_patch_op,
    _assistant_message_text,
    _is_token_invalid_text,
    _is_visible_assistant_message,
    _iter_sse_payloads,
    _sanitize_error_text,
    _sanitize_output_text,
)

MAX_STDIN_BYTES = 16 * 1024 * 1024
DEFAULT_WEB_TEXT_MODEL = "gpt-5.6-luna"
VALID_THINKING_EFFORTS = {"low", "medium", "high", "xhigh"}
ALLOWED_ROLES = {"system", "developer", "user", "assistant"}


def normalize_web_text_model(model: Any) -> str:
    raw = str(model or "").strip()
    if raw.startswith("gptfree-pool/"):
        raw = raw[len("gptfree-pool/") :].strip()
    return raw or DEFAULT_WEB_TEXT_MODEL


def normalize_thinking_effort(effort: Any) -> str:
    val = str(effort or "").strip().lower()
    if val in ("", "none", "minimal"):
        return ""
    if val == "max":
        return "xhigh"
    if val in VALID_THINKING_EFFORTS:
        return val
    return ""


def normalize_web_messages(
    raw_messages: Any,
) -> tuple[list[Dict[str, Any]], list[str], str, set[str]]:
    """Convert normalized `{role, content}` messages into ChatGPT Web payloads.

    Returns `(web_messages, assistant_history_messages, last_user_text, input_message_ids)`.
    """
    if not isinstance(raw_messages, list):
        raise ImageWorkerError(
            "messages must be a non-empty list",
            http_status=400,
            error_code="invalid_request",
        )

    web_messages: list[Dict[str, Any]] = []
    assistant_history: list[str] = []
    input_message_ids: set[str] = set()
    last_user_text = ""

    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        raw_role = str(item.get("role") or "user").strip().lower()
        if raw_role not in ALLOWED_ROLES:
            raw_role = "user"
        web_role = "system" if raw_role == "developer" else raw_role
        content = str(item.get("content") or "")
        if not content.strip():
            continue

        msg_id = str(uuid.uuid4())
        input_message_ids.add(msg_id)
        web_messages.append(
            {
                "id": msg_id,
                "author": {"role": web_role},
                "create_time": time.time(),
                "content": {"content_type": "text", "parts": [content]},
                "metadata": {
                    "developer_mode_connector_ids": [],
                    "selected_github_repos": [],
                    "selected_all_github_repos": False,
                    "serialization_metadata": {"custom_symbol_offsets": []},
                },
            }
        )
        if web_role == "assistant":
            assistant_history.append(content.strip())
        elif web_role == "user":
            last_user_text = content.strip()

    if not web_messages:
        raise ImageWorkerError(
            "Request must contain at least one non-empty message",
            http_status=400,
            error_code="invalid_request",
        )
    if not last_user_text:
        last_user_text = str(web_messages[-1]["content"]["parts"][0]).strip()
    return web_messages, assistant_history, last_user_text, input_message_ids


def strip_history_prefix(
    text: str,
    assistant_history_messages: Sequence[str],
    *,
    hold_partial_prefix: bool = False,
) -> str:
    """Strip echoed assistant history blocks while preserving legitimate short replies on finalize."""
    clean = str(text or "")
    joined = "\n\n".join(m for m in assistant_history_messages if m)
    candidates: list[str] = []
    if joined:
        candidates.append(joined)
    for msg in assistant_history_messages:
        if msg and msg not in candidates:
            candidates.append(msg)

    for cand in candidates:
        if clean.startswith(cand):
            clean = clean[len(cand) :].lstrip()
        elif hold_partial_prefix and clean and cand.startswith(clean):
            return ""
    return clean


def _is_hidden_text_path(path: str) -> bool:
    if not path:
        return False
    if path == "/message/content/parts/0":
        return False
    return (
        "/thoughts/" in path
        or "reasoning" in path
        or path.startswith("/message/content/")
    )


def _infer_sse_error_status(code: str, message: str) -> int:
    lowered = f"{code} {message}".lower()
    if any(tok in lowered for tok in ("rate_limit", "too many", "limit_exceeded", "quota", "usage_limit")):
        return 429
    if any(tok in lowered for tok in ("unauthorized", "token_revoked", "invalid_token", "session_expired")):
        return 401
    if any(tok in lowered for tok in ("moderation", "content_policy", "safety", "policy")):
        return 400
    if "forbidden" in lowered:
        return 403
    return 502


@dataclass
class WebTextStreamTracker:
    """Stateful parser tracking ChatGPT Web v1 SSE patches into clean assistant text deltas."""

    assistant_history_messages: tuple[str, ...] = ()
    input_message_ids: frozenset[str] = field(default_factory=frozenset)
    conversation_id: str = ""
    active_role: str = "assistant"
    active_channel: str = ""
    active_recipient: str = ""
    active_content_type: str = "text"
    active_hidden: bool = False
    active_is_input_echo: bool = False
    current_msg_id: str = ""
    completed_segments: list[str] = field(default_factory=list)
    current_msg_raw: str = ""
    last_patch_path: str = "/message/content/parts/0"
    emitted_text: str = ""
    blocked: bool = False
    model_slug: str = ""

    def _is_active_visible(self) -> bool:
        if self.active_is_input_echo:
            return False
        if self.active_role != "assistant":
            return False
        if self.active_hidden:
            return False
        if self.active_recipient and self.active_recipient != "all":
            return False
        if self.active_channel and self.active_channel != "final":
            return False
        if self.active_content_type in {"thoughts", "reasoning_recap", "code"}:
            return False
        return True

    def _combined_sanitized(self) -> str:
        raw = "\n\n".join(s for s in [*self.completed_segments, self.current_msg_raw] if s)
        return _sanitize_output_text(raw)

    def _next_delta(self, *, hold_partial_prefix: bool) -> str:
        sanitized = self._combined_sanitized()
        if not self.input_message_ids and self.assistant_history_messages:
            clean = strip_history_prefix(
                sanitized,
                self.assistant_history_messages,
                hold_partial_prefix=hold_partial_prefix,
            )
        else:
            clean = sanitized
        if len(clean) > len(self.emitted_text) and clean.startswith(self.emitted_text):
            delta = clean[len(self.emitted_text) :]
            self.emitted_text = clean
            return delta
        return ""

    def _handle_message(self, msg: dict[str, Any]) -> None:
        msg_id = str(msg.get("id") or "")
        role = str(((msg.get("author") or {}).get("role")) or "").strip().lower()
        content = msg.get("content")
        content_type = (
            str(content.get("content_type") or "").strip().lower()
            if isinstance(content, dict)
            else ""
        )
        metadata = msg.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}

        if msg_id and msg_id in self.input_message_ids:
            self.active_is_input_echo = True
            self.active_role = role
            self.last_patch_path = ""
            return

        previous_visible = self._is_active_visible()
        if msg_id and msg_id != self.current_msg_id:
            if previous_visible and self.current_msg_raw:
                self.completed_segments.append(self.current_msg_raw)
            self.current_msg_id = msg_id
            self.current_msg_raw = ""

        self.active_is_input_echo = False
        self.active_role = role
        self.active_channel = str(msg.get("channel") or "").strip().lower()
        self.active_recipient = str(msg.get("recipient") or "").strip().lower()
        self.active_content_type = content_type
        self.active_hidden = metadata.get("is_visually_hidden_from_conversation") is True

        slug = str(metadata.get("model_slug") or "").strip()
        if slug and self.active_role == "assistant":
            self.model_slug = slug

        if (
            self.active_role == "assistant"
            and self.active_content_type not in {"thoughts", "reasoning_recap", "code"}
        ):
            self.last_patch_path = "/message/content/parts/0"
            msg_text = _assistant_message_text(msg)
            if msg_text and self._is_active_visible():
                self.current_msg_raw = msg_text
        else:
            self.last_patch_path = ""

    def _apply_visibility_op(self, op: dict[str, Any]) -> None:
        op_p = op.get("p")
        op_o = op.get("o")
        op_v = op.get("v")
        if not isinstance(op_p, str):
            return

        if op_p == "/message/metadata/is_visually_hidden_from_conversation":
            if op_o == "remove":
                self.active_hidden = False
            elif op_o in ("add", "replace"):
                self.active_hidden = op_v is True
        elif op_p == "/message/channel":
            if op_o == "remove":
                self.active_channel = ""
            elif isinstance(op_v, str):
                self.active_channel = op_v.strip().lower()
        elif op_p == "/message/recipient":
            if op_o == "remove":
                self.active_recipient = ""
            elif isinstance(op_v, str):
                self.active_recipient = op_v.strip().lower()
        elif op_p == "/message/metadata" and isinstance(op_v, dict):
            if "is_visually_hidden_from_conversation" in op_v:
                self.active_hidden = op_v["is_visually_hidden_from_conversation"] is True
            slug = str(op_v.get("model_slug") or "").strip()
            if slug and self.active_role == "assistant":
                self.model_slug = slug

    def _handle_patch_op(self, op: dict[str, Any], *, apply_visibility: bool = True) -> None:
        op_p = op.get("p")
        op_o = op.get("o")
        op_v = op.get("v")

        if op_p == "" and op_o == "add" and isinstance(op_v, dict) and isinstance(op_v.get("message"), dict):
            self._handle_message(op_v["message"])
            return

        if apply_visibility and isinstance(op_p, str) and op_p in (
            "/message/metadata/is_visually_hidden_from_conversation",
            "/message/channel",
            "/message/recipient",
            "/message/metadata",
        ):
            self._apply_visibility_op(op)
            return

        if isinstance(op_p, str) and op_p:
            if op_p == "/message/content/parts/0":
                self.last_patch_path = "/message/content/parts/0"
                if self._is_active_visible() and isinstance(op_v, (str, int, float)):
                    self.current_msg_raw = _apply_patch_op(op, self.current_msg_raw)
                return
            if _is_hidden_text_path(op_p):
                self.last_patch_path = op_p
            return

        if op_p in (None, "") and op_o in ("append", "replace") and isinstance(op_v, str):
            if self._is_active_visible() and self.last_patch_path == "/message/content/parts/0":
                self.current_msg_raw = _apply_patch_op(op, self.current_msg_raw)

    def _handle_patch_list(self, items: list[Any]) -> None:
        dict_items = [item for item in items if isinstance(item, dict)]
        has_new_message = any(
            item.get("p") == "" and item.get("o") == "add" and isinstance(item.get("v"), dict) and "message" in item["v"]
            for item in dict_items
        )
        if not has_new_message:
            # ChatGPT Web often sends parts/0 append BEFORE removing is_visually_hidden_from_conversation in the same patch list.
            for item in dict_items:
                self._apply_visibility_op(item)
            for item in dict_items:
                self._handle_patch_op(item, apply_visibility=False)
            return
        for item in dict_items:
            self._handle_patch_op(item, apply_visibility=True)

    def feed_payload(self, payload: str) -> str:
        if not payload or payload == "[DONE]":
            return ""
        try:
            event = json.loads(payload)
        except Exception:
            return ""
        if not isinstance(event, dict):
            return ""

        conv_id = event.get("conversation_id")
        if conv_id:
            self.conversation_id = str(conv_id)
        val = event.get("v")
        if isinstance(val, dict) and val.get("conversation_id"):
            self.conversation_id = str(val["conversation_id"])

        if event.get("type") == "moderation":
            mod = event.get("moderation_response")
            if isinstance(mod, dict) and mod.get("blocked") is True:
                self.blocked = True

        err_val = event.get("error")
        if err_val:
            if isinstance(err_val, dict):
                err_msg = str(err_val.get("message") or err_val.get("code") or err_val)
                err_code = str(err_val.get("code") or "upstream_error")
            else:
                err_msg = str(err_val)
                err_code = "upstream_error"
            status = _infer_sse_error_status(err_code, err_msg)
            raise ImageWorkerError(
                _sanitize_error_text(err_msg) or "Upstream conversation error",
                http_status=status,
                error_code=err_code,
                conversation_id=self.conversation_id,
            )

        if isinstance(event.get("message"), dict):
            self._handle_message(event["message"])
        elif isinstance(val, dict) and isinstance(val.get("message"), dict):
            self._handle_message(val["message"])
        elif event.get("o") == "patch" and isinstance(val, list):
            self._handle_patch_list(val)
        elif isinstance(event.get("p"), str):
            self._handle_patch_op(event)
        elif isinstance(val, list):
            self._handle_patch_list(val)
        elif isinstance(val, str) and "p" not in event and "o" not in event:
            if self._is_active_visible() and self.last_patch_path == "/message/content/parts/0":
                self.current_msg_raw += val

        return self._next_delta(hold_partial_prefix=True)

    def finalize_delta(self) -> str:
        return self._next_delta(hold_partial_prefix=False)


class OpenAIWebTextClient(OpenAIWebImageClient):
    """Reuses OpenAIWebImageClient cookies, sentinel PoW, Turnstile and headers for text chat."""

    def _prepare_text_conversation(
        self,
        *,
        upstream_model: str,
        partial_query_text: str,
        thinking_effort: str,
        timezone_offset_min: int,
        timezone_name: str,
        requirements: Any,
    ) -> tuple[str, str]:
        path = "/backend-api/f/conversation/prepare"
        current_effort = thinking_effort

        for attempt in range(2):
            payload: Dict[str, Any] = {
                "action": "next",
                "fork_from_shared_post": False,
                "parent_message_id": "client-created-root",
                "model": upstream_model,
                "client_prepare_state": "success",
                "timezone_offset_min": int(timezone_offset_min),
                "timezone": timezone_name,
                "conversation_mode": {"kind": "primary_assistant"},
                "system_hints": [],
                "supports_buffering": True,
                "supported_encodings": ["v1"],
                "client_contextual_info": {"app_name": "chatgpt.com"},
            }
            if partial_query_text:
                payload["partial_query"] = {
                    "id": str(uuid.uuid4()),
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": [partial_query_text]},
                }
            if current_effort:
                payload["thinking_effort"] = current_effort

            response = self.session.post(
                self.base_url + path,
                headers=self._image_headers(path, requirements, accept="application/json"),
                json=payload,
                timeout=60,
            )
            if (
                attempt == 0
                and current_effort
                and response.status_code in (400, 422)
                and "thinking_effort" in str(getattr(response, "text", "") or "").lower()
            ):
                current_effort = ""
                continue
            self._ensure_ok(response, path)
            data = response.json() if hasattr(response, "json") else {}
            return str((data or {}).get("conduit_token") or ""), current_effort

        return "", current_effort

    def stream_text(
        self,
        *,
        messages: Any,
        model: str = DEFAULT_WEB_TEXT_MODEL,
        thinking_effort: str = "",
        timezone_offset_min: int = -480,
        timezone_name: str = "Asia/Shanghai",
        stream_timeout: float = 180.0,
        on_delta: Optional[Callable[[str, str], None]] = None,
    ) -> Dict[str, Any]:
        upstream_model = normalize_web_text_model(model)
        effort = normalize_thinking_effort(thinking_effort)
        web_messages, assistant_history, last_user_text, input_ids = normalize_web_messages(messages)

        self._bootstrap()
        requirements = self._get_chat_requirements()

        conduit_token, effort = self._prepare_text_conversation(
            upstream_model=upstream_model,
            partial_query_text=last_user_text,
            thinking_effort=effort,
            timezone_offset_min=timezone_offset_min,
            timezone_name=timezone_name,
            requirements=requirements,
        )

        path = "/backend-api/f/conversation"
        tracker = WebTextStreamTracker(
            assistant_history_messages=tuple(assistant_history),
            input_message_ids=frozenset(input_ids),
        )
        resp = None

        for attempt in range(2):
            body: Dict[str, Any] = {
                "action": "next",
                "messages": web_messages,
                "parent_message_id": "client-created-root",
                "model": upstream_model,
                "client_prepare_state": "sent",
                "timezone_offset_min": int(timezone_offset_min),
                "timezone": timezone_name,
                "history_and_training_disabled": True,
                "conversation_mode": {"kind": "primary_assistant"},
                "enable_message_followups": True,
                "system_hints": [],
                "supports_buffering": True,
                "supported_encodings": ["v1"],
                "client_contextual_info": {
                    "is_dark_mode": False,
                    "time_since_loaded": 25,
                    "page_height": 900,
                    "page_width": 1200,
                    "pixel_ratio": 1,
                    "screen_height": 1080,
                    "screen_width": 1920,
                    "app_name": "chatgpt.com",
                },
                "paragen_cot_summary_display_override": "allow",
                "force_parallel_switch": "auto",
            }
            if effort:
                body["thinking_effort"] = effort

            candidate = self.session.post(
                self.base_url + path,
                headers=self._image_headers(
                    path,
                    requirements,
                    conduit_token=conduit_token,
                    accept="text/event-stream",
                ),
                json=body,
                timeout=stream_timeout,
                stream=True,
            )
            if (
                attempt == 0
                and effort
                and candidate.status_code in (400, 422)
                and "thinking_effort" in str(getattr(candidate, "text", "") or "").lower()
            ):
                candidate.close()
                effort = ""
                continue
            resp = candidate
            break

        assert resp is not None
        try:
            self._ensure_ok(resp, path)
            for payload in _iter_sse_payloads(resp):
                if payload == "[DONE]":
                    break
                delta = tracker.feed_payload(payload)
                if delta and on_delta is not None:
                    on_delta(delta, tracker.model_slug)
        finally:
            try:
                resp.close()
            except Exception:
                pass

        tail = tracker.finalize_delta()
        if tail and on_delta is not None:
            on_delta(tail, tracker.model_slug)

        if tracker.blocked and not tracker.emitted_text:
            raise ImageWorkerError(
                "Response blocked by upstream moderation",
                http_status=400,
                error_code="content_policy_violation",
                conversation_id=tracker.conversation_id,
            )

        return {
            "ok": True,
            "text": tracker.emitted_text,
            "conversation_id": tracker.conversation_id,
            "model": tracker.model_slug or upstream_model,
        }


def _emit_ndjson(event: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _error_response_dict(exc: Exception) -> Dict[str, Any]:
    if isinstance(exc, UpstreamHTTPError):
        body_text = _sanitize_error_text(str(exc.body))
        msg = body_text or _sanitize_error_text(str(exc)) or f"Upstream HTTP {exc.status_code}"
        token_invalid = exc.status_code == 401 or _is_token_invalid_text(body_text or str(exc))
        if token_invalid and exc.status_code in (200, 403):
            status = 401
        else:
            status = exc.status_code
        code = (
            "rate_limit_exceeded"
            if status == 429
            else ("invalid_token" if status == 401 else "upstream_http_error")
        )
        return {
            "ok": False,
            "type": "error",
            "http_status": status,
            "error_code": code,
            "error": _sanitize_error_text(msg),
            "token_invalid": token_invalid,
            "retry_after": exc.retry_after,
        }
    if isinstance(exc, ImageWorkerError):
        msg = _sanitize_error_text(str(exc)) or "Upstream text generation error"
        token_invalid = exc.http_status == 401 or _is_token_invalid_text(msg)
        return {
            "ok": False,
            "type": "error",
            "http_status": 401 if token_invalid else exc.http_status,
            "error_code": exc.error_code or "upstream_error",
            "error": msg,
            "token_invalid": token_invalid,
            "retry_after": exc.retry_after,
        }
    msg = _sanitize_error_text(str(exc)) or exc.__class__.__name__
    token_invalid = _is_token_invalid_text(msg)
    return {
        "ok": False,
        "type": "error",
        "http_status": 401 if token_invalid else 502,
        "error_code": "worker_error",
        "error": msg,
        "token_invalid": token_invalid,
        "retry_after": None,
    }


def handle_text_payload(
    data: Any,
    *,
    session: Any = None,
    on_delta: Optional[Callable[[str, str], None]] = None,
) -> Dict[str, Any]:
    try:
        if not isinstance(data, dict):
            raise ImageWorkerError("Payload must be a JSON object", http_status=400, error_code="invalid_request")
        access_token = str(data.get("access_token") or "").strip()
        if not access_token:
            raise ImageWorkerError(
                "Missing access_token for Web text request",
                http_status=401,
                error_code="missing_token",
            )
        proxy = str(data.get("proxy") or "").strip()
        model = str(data.get("model") or DEFAULT_WEB_TEXT_MODEL).strip()
        effort = str(data.get("thinking_effort") or "").strip()
        tz_offset = int(data.get("timezone_offset_min") or -480)
        tz_name = str(data.get("timezone") or "Asia/Shanghai").strip() or "Asia/Shanghai"
        timeout_val = float(data.get("stream_timeout") or 180.0)

        with OpenAIWebTextClient(
            access_token,
            proxy=proxy,
            upstream_model=normalize_web_text_model(model),
            thinking_effort=normalize_thinking_effort(effort),
            session=session,
        ) as client:
            result = client.stream_text(
                messages=data.get("messages"),
                model=model,
                thinking_effort=effort,
                timezone_offset_min=tz_offset,
                timezone_name=tz_name,
                stream_timeout=timeout_val,
                on_delta=on_delta,
            )
            return result
    except Exception as exc:
        return _error_response_dict(exc)


def main() -> None:
    stream_events = "--stream" in sys.argv[1:]
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            raise ImageWorkerError("Input payload exceeds maximum size", http_status=413, error_code="payload_too_large")
        data = json.loads(raw.decode("utf-8"))
        if isinstance(data, dict) and data.get("stream_events") is True:
            stream_events = True
    except Exception as exc:
        err = _error_response_dict(exc)
        _emit_ndjson(err)
        sys.exit(1)

    def emit_delta(delta: str, model_slug: str) -> None:
        if stream_events and delta:
            ev: Dict[str, Any] = {"type": "delta", "delta": delta}
            if model_slug:
                ev["model"] = model_slug
            _emit_ndjson(ev)

    result = handle_text_payload(data, on_delta=emit_delta if stream_events else None)
    if stream_events:
        if result.get("ok"):
            _emit_ndjson(
                {
                    "ok": True,
                    "type": "done",
                    "text": result.get("text", ""),
                    "conversation_id": result.get("conversation_id", ""),
                    "model": result.get("model", ""),
                }
            )
            sys.exit(0)
        _emit_ndjson(result)
        sys.exit(1)

    _emit_ndjson(result)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
