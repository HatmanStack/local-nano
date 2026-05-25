# Local Nano — Privacy Policy

_Last updated: 2026-05-24_

Local Nano is a browser extension that runs an AI language model **entirely on
your own device**, inside your browser. It is built so your data never leaves
your machine.

## Data we collect

**None.** Local Nano has no account, no sign-in, no analytics, and no
telemetry. We do not collect, transmit to any server we control, or sell any
personal information, and we do not track you in any way.

## What stays on your device

- **Your prompts** go only to the local model running in a hidden offscreen
  document in your browser. They are never transmitted off the device.
- **Page content you ask about.** On the first turn of a conversation, the page
  title, URL, and a short body excerpt (capped at 1500 characters) are included
  in the prompt sent to the **local** model. This is not transmitted anywhere.
- **Selected text you rewrite** is processed locally; the rewrite is applied in
  the page in place.
- **Conversation history** is stored locally via `chrome.storage.local`, scoped
  per site (origin + path). It is never synced or transmitted.
- **A small device-capability record** (which model precision/device tier
  loaded successfully) is stored locally so later sessions can skip a
  configuration that previously failed.
- **Model responses** are generated locally.
- **The "Copy diagnostic" output** contains only device/adapter info, the chosen
  model and tier, the load path that was tried, an error class/message, and the
  extension and browser versions — no prompts, page content, or history. It is
  copied to your clipboard only when you click it; nothing is ever auto-sent.

## The only network access

The single network request Local Nano makes is a **one-time download of the
open model's weight files from Hugging Face** (`huggingface.co`,
`*.huggingface.co`, `cdn-lfs.huggingface.co`), which are then cached on your
device. That request downloads model data only — it sends none of your content,
prompts, or browsing information.

## No cloud AI services

Unlike some other Gemenie Labs applications, Local Nano does **not** use Google
Gemini, OpenAI, Amazon Web Services, or any other remote service to process your
data. All inference is local. (The bundled Prompt API polyfill ships with its
cloud backends removed, so it cannot reach a remote LLM provider.)

## Permissions

- **storage** — save your conversation history and the device-capability record
  locally.
- **offscreen** — host the local model in a hidden offscreen document so it
  loads once and is shared across tabs.
- **Host access to Hugging Face domains** — the one-time model-weights download
  described above.
- **Content script on the pages where you open the panel** — to read the visible
  page text (to answer questions about it) and apply your requested in-place
  rewrites, all locally.

## Clearing your data

Remove the stored history by clearing the extension's storage (DevTools →
Application → Extension Storage) or by uninstalling the extension.

## Data sharing

We do not sell or transfer your data to third parties. We do not use or transfer
your data for any purpose unrelated to the extension's single function, and we
do not use it to determine creditworthiness or for lending.

## Contact

Questions about this policy: open an issue at
<https://github.com/HatmanStack/local-nano/issues>, or contact Gemenie Labs LLC
via the Contact Us page at <https://hatstack.fun>.
