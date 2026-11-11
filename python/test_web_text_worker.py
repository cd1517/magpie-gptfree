import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

PYTHON_DIR = Path(__file__).resolve().parent
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

import web_text_worker


class FakeResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        json_data=None,
        text: str = "",
        headers: dict[str, str] | None = None,
        cookies: dict[str, str] | None = None,
        lines: list[bytes] | None = None,
    ) -> None:
        self.status_code = status_code
        self._json_data = json_data
        self._text = text
        self.headers = headers or {}
        self.cookies = cookies or {}
        self._lines = lines or []
        self.closed = False

    def json(self):
        if self._json_data is not None:
            return self._json_data
        return json.loads(self._text or "{}")

    @property
    def text(self) -> str:
        if self._text:
            return self._text
        if self._json_data is not None:
            return json.dumps(self._json_data)
        return ""

    def iter_lines(self):
        yield from self._lines

    def close(self) -> None:
        self.closed = True


class FakeSession:
    def __init__(self, handler) -> None:
        self.handler = handler
        self.calls: list[tuple[str, str, dict]] = []
        self.closed = False

    def get(self, url: str, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.handler("GET", url, kwargs)

    def post(self, url: str, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.handler("POST", url, kwargs)

    def close(self) -> None:
        self.closed = True


def _sse_lines(events: list[object]) -> list[bytes]:
    out = []
    for ev in events:
        if isinstance(ev, str):
            out.append(f"data: {ev}\n".encode("utf-8"))
        else:
            out.append(f"data: {json.dumps(ev)}\n".encode("utf-8"))
        out.append(b"")
    return out


class WebTextWorkerTests(unittest.TestCase):
    def test_normalization_and_messages_mapping(self) -> None:
        self.assertEqual(web_text_worker.normalize_web_text_model("gptfree-pool/gpt-6-luna"), "gpt-6-luna")
        self.assertEqual(web_text_worker.normalize_thinking_effort("minimal"), "")
        self.assertEqual(web_text_worker.normalize_thinking_effort("MAX"), "xhigh")
        self.assertEqual(web_text_worker.normalize_thinking_effort("high"), "high")

        web_msgs, history, last_user, input_ids = web_text_worker.normalize_web_messages([
            {"role": "developer", "content": "Be brief."},
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
            {"role": "user", "content": "What is 2+2?"},
            {"role": "user", "content": "   "},
        ])
        self.assertEqual([m["author"]["role"] for m in web_msgs], ["system", "user", "assistant", "user"])
        self.assertEqual(history, ["Hello!"])
        self.assertEqual(last_user, "What is 2+2?")
        self.assertEqual(len(input_ids), 4)

    def test_tracker_streams_v1_patches_hides_thoughts_and_strips_citations_and_history(self) -> None:
        tracker = web_text_worker.WebTextStreamTracker(assistant_history_messages=("Okay, understood.",))
        events = [
            "v1",
            {
                "v": {
                    "message": {
                        "id": "msg-thought",
                        "author": {"role": "assistant"},
                        "channel": "commentary",
                        "content": {"content_type": "thoughts", "parts": [""]},
                    },
                    "conversation_id": "conv-123",
                }
            },
            {"p": "/message/content/thoughts/0/content", "o": "append", "v": "Internal reasoning"},
            {"v": " should stay hidden"},
            {
                "v": {
                    "message": {
                        "id": "msg-final",
                        "author": {"role": "assistant"},
                        "channel": "final",
                        "recipient": "all",
                        "content": {"content_type": "text", "parts": [""]},
                    }
                }
            },
            # Partial echo followed by full history echo -> stripped cleanly
            {
                "o": "patch",
                "v": [
                    {"p": "/message/content/parts/0", "o": "append", "v": "Okay, "},
                    {"p": "/message/metadata", "o": "append", "v": {"model_slug": "gpt-6-luna"}},
                ],
            },
            {"v": "understood.\n\nAns\ue200cite"},
            {"v": "turn0\ue201wer"},
            "[DONE]",
        ]

        deltas = []
        for ev in events:
            payload = ev if isinstance(ev, str) else json.dumps(ev)
            d = tracker.feed_payload(payload)
            if d:
                deltas.append(d)
        tail = tracker.finalize_delta()
        if tail:
            deltas.append(tail)

        self.assertEqual("".join(deltas), "Answer")
        self.assertEqual(tracker.conversation_id, "conv-123")
        self.assertEqual(tracker.model_slug, "gpt-6-luna")

        # Short valid reply that happens to start like assistant history must still flush on finalize
        short_tracker = web_text_worker.WebTextStreamTracker(assistant_history_messages=("Okay, understood.",))
        short_tracker.feed_payload(json.dumps({
            "v": {"message": {"id": "a1", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["Okay"]}}}
        }))
        self.assertEqual(short_tracker.emitted_text, "")
        self.assertEqual(short_tracker.finalize_delta(), "Okay")

        # Real ChatGPT Web behavior: echoed prompt assistant IDs + provisional is_visually_hidden_from_conversation removed inside patch list
        echo_tracker = web_text_worker.WebTextStreamTracker(
            assistant_history_messages=("alpha",),
            input_message_ids=frozenset({"echo-assistant-1"}),
        )
        self.assertEqual(
            echo_tracker.feed_payload(json.dumps({
                "v": {"message": {"id": "echo-assistant-1", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["alpha"]}}}
            })),
            "",
        )
        self.assertEqual(
            echo_tracker.feed_payload(json.dumps({
                "v": {
                    "message": {
                        "id": "real-assistant-2",
                        "author": {"role": "assistant"},
                        "metadata": {"is_visually_hidden_from_conversation": True},
                        "content": {"content_type": "text", "parts": [""]},
                    }
                }
            })),
            "",
        )
        self.assertEqual(
            echo_tracker.feed_payload(json.dumps({
                "o": "patch",
                "v": [
                    {"p": "/message/content/parts/0", "o": "append", "v": "alpha-2"},
                    {"p": "/message/metadata/is_visually_hidden_from_conversation", "o": "remove"},
                ],
            })),
            "alpha-2",
        )

    def test_end_to_end_stream_with_prepare_conduit_and_effort_fallback(self) -> None:
        conv_calls: list[dict] = []

        def handler(method: str, url: str, kwargs: dict):
            if method == "GET" and url == "https://chatgpt.com/":
                return FakeResponse(status_code=200, cookies={"oai-did": "did-1"})
            if url.endswith("/backend-api/sentinel/chat-requirements/prepare"):
                return FakeResponse(status_code=200, json_data={"prepare_token": "prep-1"})
            if url.endswith("/backend-api/sentinel/chat-requirements/finalize"):
                return FakeResponse(status_code=200, json_data={"token": "req-tok-1"})
            if url.endswith("/backend-api/f/conversation/prepare"):
                req_json = kwargs.get("json") or {}
                self.assertEqual(req_json.get("system_hints"), [])
                return FakeResponse(status_code=200, json_data={"conduit_token": "conduit-abc"})
            if url.endswith("/backend-api/f/conversation"):
                req_json = kwargs.get("json") or {}
                conv_calls.append(req_json)
                if "thinking_effort" in req_json:
                    return FakeResponse(
                        status_code=400,
                        json_data={"detail": "thinking_effort is not supported for this model"},
                    )
                self.assertEqual(kwargs["headers"].get("X-Conduit-Token"), "conduit-abc")
                self.assertTrue(req_json.get("history_and_training_disabled"))
                return FakeResponse(
                    status_code=200,
                    lines=_sse_lines([
                        "v1",
                        {
                            "v": {
                                "message": {
                                    "id": "m1",
                                    "author": {"role": "assistant"},
                                    "content": {"content_type": "text", "parts": [""]},
                                },
                                "conversation_id": "conv-web-1",
                            }
                        },
                        {
                            "o": "patch",
                            "v": [
                                {"p": "/message/content/parts/0", "o": "append", "v": "Hello"},
                                {"p": "/message/metadata", "o": "append", "v": {"model_slug": "gpt-5.6-luna"}},
                            ],
                        },
                        {"v": " world"},
                        "[DONE]",
                    ]),
                )
            raise AssertionError(f"Unexpected call: {method} {url}")

        deltas: list[str] = []
        session = FakeSession(handler)
        res = web_text_worker.handle_text_payload(
            {
                "access_token": "tok-1",
                "model": "gpt-5.6-luna",
                "thinking_effort": "high",
                "messages": [{"role": "user", "content": "Greet me"}],
            },
            session=session,
            on_delta=lambda d, _m: deltas.append(d),
        )
        self.assertTrue(res["ok"])
        self.assertEqual(deltas, ["Hello", " world"])
        self.assertEqual(res["text"], "Hello world")
        self.assertEqual(len(conv_calls), 2)
        self.assertEqual(conv_calls[0].get("thinking_effort"), "high")
        self.assertNotIn("thinking_effort", conv_calls[1])

    def test_error_mapping_401_and_429_and_sse_rate_limit(self) -> None:
        def rate_limit_handler(method: str, url: str, kwargs: dict):
            if method == "GET" and url == "https://chatgpt.com/":
                return FakeResponse(status_code=200)
            if "/sentinel/chat-requirements/" in url:
                return FakeResponse(status_code=429, headers={"Retry-After": "45"}, json_data={"detail": "slow down"})
            raise AssertionError(url)

        res429 = web_text_worker.handle_text_payload(
            {"access_token": "tok-1", "model": "gpt-6-luna", "messages": [{"role": "user", "content": "hi"}]},
            session=FakeSession(rate_limit_handler),
        )
        self.assertFalse(res429["ok"])
        self.assertEqual(res429["http_status"], 429)
        self.assertEqual(res429["retry_after"], 45)
        self.assertEqual(res429["error_code"], "rate_limit_exceeded")

        # SSE stream-embedded error should also classify cleanly
        tracker = web_text_worker.WebTextStreamTracker()
        with self.assertRaises(web_text_worker.ImageWorkerError) as ctx:
            tracker.feed_payload(json.dumps({"error": {"code": "usage_limit", "message": "Too many requests"}}))
        self.assertEqual(ctx.exception.http_status, 429)


if __name__ == "__main__":
    unittest.main()
