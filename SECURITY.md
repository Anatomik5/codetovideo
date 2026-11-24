# Security Policy

## What CTV does on your machine (read this before running it)

- It **launches the application you point it at** (`--file` / `--repo`) and **clicks through it like a user** in a headless browser, including uploading the files you pass with `--upload`. Do not point it at systems that hold real data or where clicking has side effects (payments, deletions, e-mails).
- It sends repository excerpts (file tree, README, key manifests) and page text and button labels to **the LLM endpoint you configure**. With a local model (Ollama) nothing leaves your machine. With a cloud endpoint, that content goes to that provider. CTV itself makes **no other network requests** and has no telemetry.
- An untrusted repository's README could try to talk the model into proposing a malicious start command. CTV therefore **ignores model-proposed launch commands** that are not a plain call to a known dev runtime (python, node, npm, uvicorn, cargo, ...) without shell operators. Use `--launch "<command>"` to choose the command yourself. Treat any untrusted repository as untrusted code regardless: running its dev server executes its code.
- The desktop app stores your API key encrypted with the operating-system keychain when available (DPAPI / Keychain / libsecret); otherwise it falls back to plain text in the app's user-data folder. The key is handed to the pipeline through an environment variable, never on a command line.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's *Report a vulnerability* (private security advisory) on this repository. Include steps to reproduce, the affected version or commit, and the impact. We will acknowledge within a few days and credit you in the changelog if you wish.

## Supported versions

Only the latest `main` / latest release is supported while the project is pre-1.0.
