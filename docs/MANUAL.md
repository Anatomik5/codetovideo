# CTV Manual

[Русская версия](ru/MANUAL.md) · [Back to README](../README.md)

## 1. Install (once)

1. Install **Node.js 20+** (22 recommended) (<https://nodejs.org>).
2. *(Free local model)* Install **Ollama** (<https://ollama.com>), then in a terminal: `ollama pull qwen3.5:4b`.
3. In the project folder run `npm install` (downloads Electron and Chromium; takes a few minutes).

## 2. Start

- Windows: double-click `start-app.vbs` (no console window)
- macOS / Linux: `./start-app.sh`
- Any system: `npm run app`

## 3. Connect a model

In the **Model** block:

| You use | Provider | Model example | API key |
| --- | --- | --- | --- |
| Local Ollama | Ollama | `qwen3.5:4b` | leave empty |
| Google Gemini | Google Gemini | `gemini-2.5-flash` | your key |
| OpenRouter | OpenRouter | `openrouter/free` | your key |
| Anything else OpenAI-compatible | Custom URL | model name | key if required |

For Ollama the model list fills in by itself. If Ollama is not running, CTV starts it for you.

## 4. Create a video

1. **Source** — pick *one*:
   - **Folder / File**: your project (or its launch file, e.g. `dev.py`). CTV starts the app and finds its address.
   - **URL**: an app that is already running, e.g. `http://localhost:3000`.
2. **Files to upload** — if the app needs files (a spreadsheet, JSON…), add them **in the order** the app asks for them.
3. **Theme** — `auto` copies the app's own look.
   **Format** — *Demo walkthrough* or *Corporate promo* (ad-style camera moves and call-outs, no audio).
   **Background** — who makes the demo backdrop: model draws it, model picks a built-in motif (fast), or auto.
   **Quality** — 480p up to 4K. Higher is sharper but records and renders slower; 720p is a good default.
4. **Prompt** — describe the video (see tips below).
5. Press **Generate video**. Watch the **Log**; a ~1-minute video takes several minutes. **Stop** cancels.

The finished video appears in **Output**; **Show in folder** opens its location (`out/demo.mp4`).

### Prompt tips

State what you want in your own words, any language:

- **Scenario:** "show the full flow from upload to export".
- **Caption language:** "titles and captions in English" / "на русском".
- **Pace:** "scroll slowly", "give each screen time" → slower scrolling and longer holds.
- **Style & background:** "industrial style with a construction crane in the background", "dark neon with circuit lines".
- **What to skip:** "don't open the settings page".

Short and concrete beats long and vague.

## 5. Edit a video

Open the **Edit** tab. The scenes of the last video are listed with their titles and captions.

1. Click a scene.
2. Describe the change:
   - *text / style:* "make the title Cost Breakdown", "shorter caption", "warmer colours", "different background with …" — fast, the footage is not re-recorded;
   - *footage:* "re-shoot this step and scroll down to the table" — only that scene is recorded again.
3. Press **Apply edit**.

**Re-render only** rebuilds the final video from the saved clips (useful after manual changes to `out/sessions/<id>/manifest.json`).

Edits always apply to the **newest** session.

## 6. Where things are

| What | Where |
| --- | --- |
| Final video | `out/demo.mp4` |
| Saved sessions | `out/sessions/<id>/` (`manifest.json`, `clips/`, `props.json`) |
| App settings | the app's user-data folder (`settings.json`) |

## 7. Troubleshooting

| Problem | What to do |
| --- | --- |
| "Model not found" in the log | `ollama pull <model>` with the exact name you typed. |
| Nothing happens / endless wait with Ollama | First call loads the model — give it a minute. Check Ollama is installed (`ollama --version`). |
| "Could not detect a running web UI URL" | Use the **URL** field with the app's address, or give `--launch "<command>"` / `--port`. |
| Video stops early | The log ends with a `stopReason`: the app needs input CTV doesn't have (e.g. a file). Add the file under *Files to upload*. |
| Titles in the wrong language | Say the language explicitly in the prompt. |
| Weak background drawing | Normal for tiny models: CTV completes it automatically; a bigger model draws better. |
| Edit says a scene is not found | Edit works on the newest session; generate or select the right one. |

## 8. Command line

Everything the app does is available as a CLI — see the flag table in the [README](../README.md#cli-reference).

## 9. Known limits

CTV is alpha. See [README, Honest status](../README.md#honest-status) for what is tested and what is not, and [ROADMAP.md](../ROADMAP.md) if you want to help.
