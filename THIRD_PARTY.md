# Third-party software

CTV itself is MIT-licensed (see [LICENSE](LICENSE)). It builds on the projects below; **their** licenses apply to their code. Please read them, especially Remotion's.

| Project | Used for | License |
| --- | --- | --- |
| [Remotion](https://www.remotion.dev) | Rendering the final video | **Source-available, not plain MIT.** Free for individuals and small companies; larger companies need a paid company license. Check <https://www.remotion.pro/license> before using CTV commercially. |
| [Playwright](https://playwright.dev) | Driving and recording the browser | Apache-2.0 |
| [FFmpeg](https://ffmpeg.org) (binaries shipped with Remotion) | Encoding and splicing clips | LGPL/GPL depending on the build; used as a separate process |
| [Electron](https://www.electronjs.org) | Desktop app shell | MIT |
| [OpenAI Node SDK](https://github.com/openai/openai-node) | OpenAI-compatible client | Apache-2.0 |
| [React](https://react.dev) | Video components | MIT |
| [Shiki](https://shiki.style) | Syntax highlighting | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | `.env` loading | BSD-2-Clause |
| [Ollama](https://ollama.com) (optional, not bundled) | Local models | MIT; every model has its own license (for example Qwen: see its model card) |

Videos you generate from your own apps are yours. Mind the license of any model you use and of the app you record.

If something here is inaccurate, please open an issue.
