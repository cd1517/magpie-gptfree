# Third-party authentication sources

The user asked that GPTFree use the same HTTP password/TOTP authentication
approach as their [chatgpt2api-dsh](https://github.com/yang0/chatgpt2api-dsh).

- `auth_worker.py`: adapted from
  `yang0/chatgpt2api-dsh/scripts/auth-worker.py`.
- `utils/pkce.py` and `utils/sentinel.py`: copied from
  `basketikun/chatgpt2api` (MIT license; notice in THIRD_PARTY_LICENSE.txt).
- `curl_cffi` is installed separately from PyPI into a local Python venv.

The imported worker requests **Platform OAuth** (`platform.openai.com`);
tokens are not guaranteed to authenticate the separate Codex backend.
GPTFree must verify service access before admitting a token to its pool.
