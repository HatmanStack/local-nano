# Privacy

`local-nano` is designed so that prompts and page content stay on your machine. Here is exactly what crosses the network and what doesn't.

## What does leave your machine

- **Model weights, on first use.** When the chat panel is opened for the first time, Transformers.js downloads the configured model from Hugging Face (`huggingface.co` and `cdn-lfs.huggingface.co`). The host permissions for those domains are declared in `manifest.json`. Subsequent loads come from the browser cache.
- **Whatever the page itself sends.** The extension does not block or interfere with the host page's own network activity.

That's the entire list of outbound traffic the extension causes.

## What stays on your machine

- **Your prompts.** Sent only to the in-page polyfill, which runs the model locally.
- **The page content you ask about.** On the first turn of a conversation, the page title, URL, and a body excerpt (capped at 1500 characters) are included in the prompt. They are not transmitted anywhere — they are passed to the local model.
- **Conversation history.** Persisted in `chrome.storage.local`, scoped per `origin + pathname`. This storage is local to your browser profile.
- **Model responses.** Generated locally.

## Permissions, explained

From `manifest.json`:

| Permission                               | Why it's needed                                                   |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `activeTab`                              | So the toggle hotkey can reach the current tab.                   |
| `scripting`                              | Standard MV3 plumbing for content-script injection.               |
| `storage`                                | Persist conversation history in `chrome.storage.local`.           |
| `host_permissions` for `huggingface.co` and `*.huggingface.co` | Download model weights from Hugging Face and its CDN subdomains. |
| `host_permissions` for `cdn-lfs.huggingface.co` | Download large model files from Hugging Face's LFS CDN. |
| `host_permissions` for `cdn.jsdelivr.net` | Fallback CDN used by Transformers.js (rarely hit — the ORT wasm files are bundled in `dist/ort/` to avoid this). |

The content script declares `matches: ["<all_urls>"]`. That is required for the assistant to be available on any page, but it also means the extension can read DOM on every page. If that matters to you, narrow it before publishing.

## Clearing history

To wipe stored chat history:

- Per-site: clear that site's storage in DevTools → Application → Storage → Extension Storage.
- All sites: remove and reinstall the extension, or run `chrome.storage.local.clear()` from the extension's DevTools console.

## Caveat

This describes the extension's own behavior. The vendored polyfill (`vendor/prompt-api-polyfill/`) is third-party code from Google. The slimmed `backends-registry.js` in this repo intentionally drops the firebase / gemini / openai backends so the polyfill cannot reach a cloud LLM provider, but if you re-enable them in your fork, the privacy story changes accordingly.
