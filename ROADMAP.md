# Roadmap and help wanted

CTV works end to end on the author's machine, with a small local model, on one real app plus the bundled example. That is a **very small test surface**. Everything below is honest: these are the weak spots and the ideas. Items marked 🙋 are good places to jump in; comment on (or open) an issue before starting.

## Weak spots (please help us find more)

- 🙋 **Only tested on Windows 11.** The unit tests pass on macOS and Linux (contributor runs, #12 and #17), but the full pipeline (browser, recording, rendering, desktop app) has not been run on macOS or Linux yet. Reports welcome ([#1](https://github.com/Anatomik5/codetovideo/issues/1)).
- 🙋 **Only a handful of apps tried.** One real Next.js + FastAPI wizard and the bundled `hello-wizard`. Logins, multi-tab apps, drag-and-drop, canvas apps, iframes and shadow DOM are likely to defeat the agent. It stops with a `stopReason` instead of looping, but that is not the same as working.
- 🙋 **Background drawings that miss the edges** are accepted in `--backdrop generate` mode ([#13](https://github.com/Anatomik5/codetovideo/issues/13)).
- **Pacing varies a lot between models** when the prompt does not ask for one ([#16](https://github.com/Anatomik5/codetovideo/issues/16)).
- 🙋 **Small-model quality.** A 4B model produces serviceable plans but often generic captions, a mediocre scene split and sparse background drawings. Prompts and validators could be much better.
- **Button-role detection costs LLM latency** (cached per label; the first screen is classified in an unrecorded warm-up pass). A faster or non-LLM signal would help, as long as it stays language-free.
- **Re-shoot of a single scene** can show a small cursor / scroll jump at the cut.
- **Recording tops out at what Chromium's screencast gives us** (real device-scale capture works, but 4K is slow and heavy).
- **No hosted CI and no end-to-end tests.** Checks run locally (`npm run check`). A ready-to-use GitHub Actions workflow is kept in `docs/ci.yml.example` (copy it to `.github/workflows/ci.yml` on a fork or once the maintainer's account can run Actions). A scripted end-to-end run against `examples/hello-wizard` with a tiny local model would catch regressions.
- **Remotion's license** is not plain MIT (see [THIRD_PARTY.md](THIRD_PARTY.md)). Companies above a small size need a paid license. An alternative renderer would remove that constraint.

## Ideas

- ✅ **Subtitles:** `.srt` and `.vtt` with readable, proportionally timed cues are done (thanks Dathinel, #7 and #10). Possible next step: burn-in captions as an option.
- 🙋 **More promo templates** (different camera language, vertical 9:16 and square formats for social posts).
- 🙋 **Packaging:** electron-builder installers for Windows / macOS / Linux (unsigned is fine to start).
- 🙋 **Docker image** that runs the pipeline headless with a local model sidecar.
- ✅ **Unit tests for scene planning, the partial-render planner and scene editing** (thanks TONstories, #12, and avaldivieso-meraki, #17).
- **Optional narration with a free local TTS** (opt-in, off by default, keeping the "no paid service" rule): design discussion in #9. Background music is a later question.
- **Better scene planning from a user's own storyboard** (a Markdown outline instead of one prompt).
- **Pluggable "format" API** so formats can live outside the core.
- 🙋 **Runtimes without an OpenAI-compatible API** (for example LiteRT-LM builds of Gemma 4): a small bridge ([#15](https://github.com/Anatomik5/codetovideo/issues/15)).
- **Vision-assisted navigation** for strong multimodal models (optional, never required).
- **Translations** of the README and manual (see CONTRIBUTING.md).

## How to take something

Open an issue titled with the item, say you are on it, ask questions early. Small PRs beat big ones.
