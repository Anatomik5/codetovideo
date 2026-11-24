# Roadmap and help wanted

CTV works end to end on the author's machine, with a small local model, on one real app plus the bundled example. That is a **very small test surface**. Everything below is honest: these are the weak spots and the ideas. Items marked 🙋 are good places to jump in; comment on (or open) an issue before starting.

## Weak spots (please help us find more)

- 🙋 **Only tested on Windows 11.** macOS and Linux paths exist (`start-app.sh`, non-Windows branches) but have not been run by anyone. Reports welcome.
- 🙋 **Only a handful of apps tried.** One real Next.js + FastAPI wizard and the bundled `hello-wizard`. Logins, multi-tab apps, drag-and-drop, canvas apps, iframes and shadow DOM are likely to defeat the agent. It stops with a `stopReason` instead of looping, but that is not the same as working.
- 🙋 **Small-model quality.** A 4B model produces serviceable plans but often generic captions, a mediocre scene split and sparse background drawings. Prompts and validators could be much better.
- **Button-role detection costs LLM latency** (cached per label; the first screen is classified in an unrecorded warm-up pass). A faster or non-LLM signal would help, as long as it stays language-free.
- **Re-shoot of a single scene** can show a small cursor / scroll jump at the cut.
- **Recording tops out at what Chromium's screencast gives us** (real device-scale capture works, but 4K is slow and heavy).
- **No hosted CI and no end-to-end tests.** Checks run locally (`npm run check`). A ready-to-use GitHub Actions workflow is kept in `docs/ci.yml.example` (copy it to `.github/workflows/ci.yml` on a fork or once the maintainer's account can run Actions). A scripted end-to-end run against `examples/hello-wizard` with a tiny local model would catch regressions.
- **Remotion's license** is not plain MIT (see [THIRD_PARTY.md](THIRD_PARTY.md)). Companies above a small size need a paid license. An alternative renderer would remove that constraint.

## Ideas

- 🙋 **Subtitles export (`.srt` / `.vtt`)** from the scene manifest: tiny, self-contained, and useful.
- 🙋 **More promo templates** (different camera language, vertical 9:16 and square formats for social posts).
- 🙋 **Packaging:** electron-builder installers for Windows / macOS / Linux (unsigned is fine to start).
- 🙋 **Docker image** that runs the pipeline headless with a local model sidecar.
- 🙋 **More unit tests** for `planScenes`, edit-patch parsing and the partial-render planner.
- **Free local TTS + music** (opt-in) to give the videos a voice, keeping the "no paid service" rule. Needs a design discussion first.
- **Better scene planning from a user's own storyboard** (a Markdown outline instead of one prompt).
- **Pluggable "format" API** so formats can live outside the core.
- **Vision-assisted navigation** for strong multimodal models (optional, never required).
- **Translations** of the README and manual (see CONTRIBUTING.md).

## How to take something

Open an issue titled with the item, say you are on it, ask questions early. Small PRs beat big ones.
