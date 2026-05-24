# Privacy

`local-nano` is designed so that prompts and page content stay on your machine. Here is exactly what crosses the network and what doesn't.

## What does leave your machine

- **Model weights, on first use.** When the chat panel is opened for the first time, Transformers.js downloads the configured model from Hugging Face (`huggingface.co` and `cdn-lfs.huggingface.co`). The host permissions for those domains are declared in `manifest.json`. Subsequent loads come from the browser cache.
- **Whatever the page itself sends.** The extension does not block or interfere with the host page's own network activity.

The ORT runtime files are bundled into `dist/ort/` and loaded locally, so the extension no longer declares a `cdn.jsdelivr.net` host permission and causes no jsdelivr traffic.

That's the entire list of outbound traffic the extension causes.

## What stays on your machine

- **Your prompts.** Sent only to the in-page chat client, which streams them to the model running in a hidden offscreen document on your machine. They never leave the device.
- **The page content you ask about.** On the first turn of a conversation, the page title, URL, and a body excerpt (capped at 1500 characters) are included in the prompt. They are not transmitted anywhere — they are passed to the local model.
- **Conversation history.** Persisted in `chrome.storage.local`, scoped per `origin + pathname`. This storage is local to your browser profile.
- **Model responses.** Generated locally.
- **The load diagnostic.** The "Copy diagnostic" control in the panel (and the diagnostic embedded in a load-failure message) contains only device/capability info (device, software-fallback flag, adapter buffer size), the chosen model and active tier, the ladder path that was walked, an error class and message, the extension version, and the browser user agent. It holds no prompts, page content, or chat history. It is built on demand and copied to your clipboard locally; nothing is ever auto-sent, logged to the network, or persisted.

## Permissions, explained

From `manifest.json`:

| Permission                               | Why it's needed                                                   |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `storage`                                | Persist conversation history in `chrome.storage.local`.           |
| `offscreen`                              | Host the long-lived `LanguageModel` session in a hidden offscreen document. |
| `host_permissions` for `huggingface.co` and `*.huggingface.co` | Download model weights from Hugging Face and its CDN subdomains. |
| `host_permissions` for `cdn-lfs.huggingface.co` | Download large model files from Hugging Face's LFS CDN. |

The content script is declared statically in `manifest.json` with `matches: ["<all_urls>"]` (no `activeTab` or `scripting` permission is needed for a static content-script declaration). That match is required for the assistant to be available on any page, but it also means the extension can read DOM on every page. If that matters to you, narrow it before publishing.

## Clearing history

To wipe stored chat history:

- Per-site: clear that site's storage in DevTools → Application → Storage → Extension Storage.
- All sites: remove and reinstall the extension, or run `chrome.storage.local.clear()` from the extension's DevTools console.

## Caveat

This describes the extension's own behavior. The vendored polyfill (`vendor/prompt-api-polyfill/`) is third-party code from Google. The slimmed `backends-registry.js` in this repo intentionally drops the firebase / gemini / openai backends so the polyfill cannot reach a cloud LLM provider, but if you re-enable them in your fork, the privacy story changes accordingly.
