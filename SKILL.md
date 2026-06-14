---
name: "vsix-image-gen"
description: "Use when the user asks to generate or edit images with VSIX GPT-Image, including Chinese triggers like 生图、画图、生成图片、参考这张图、把这张图改成 and English requests like generate an image, edit this photo, or transform this picture. Handles first-run API key setup, local or remote reference images, and runs the bundled Node CLI for reliable execution."
---

# VSIX Image Gen

Generate or edit images through VSIX's `gpt-image-2` endpoint. Prefer the bundled Node CLI so setup, request shape, and reference-image handling stay consistent across agent runs.

## Workflow
1. Collect the user's prompt and decide whether this is text-to-image or image-to-image.
2. Verify Node.js is available with `node -v`. If it is missing, ask the user to install Node.js from `https://nodejs.org/` before continuing.
3. Resolve the API key from `VSIX_API_KEY` or `~/.vsix/config.json`. If neither is available, guide the user to create a VSIX API key on `https://vsix.cc` and save it locally. Do not ask them to paste the full key in chat.
4. Choose a size:
   - square or default: `1024x1024`
   - portrait or phone wallpaper: `1024x1536`
   - landscape: `1536x1024`
   - wide landscape: `1536x864`, `1920x1080`, or `3840x2160`
   - vertical video or phone wallpaper: `864x1536`, `1080x1920`, or `2160x3840`
   - high-resolution square: `2048x2048` or `2160x2160`
   - no preference: `auto`
5. If the user supplies one or more reference images, pass each one with `--image-url`. The CLI accepts remote URLs, `data:` URIs, and local file paths. Local files are converted to data URIs automatically.
6. Run the CLI and return the generated image URL or data URI from stdout.

## Environment
- Preferred auth: `VSIX_API_KEY`
- Fallback auth file: `~/.vsix/config.json`
- Expected config shape:

```json
{"api_key":"YOUR_VSIX_KEY"}
```

## First-run setup
If `~/.vsix/config.json` does not exist and `VSIX_API_KEY` is unset, tell the user to create a key on `https://vsix.cc` and save it locally:

macOS / Linux:
```bash
mkdir -p ~/.vsix
printf '%s\n' '{"api_key":"PASTE_YOUR_KEY_HERE"}' > ~/.vsix/config.json
```

Windows PowerShell:
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.vsix" | Out-Null
Set-Content -Path "$env:USERPROFILE\.vsix\config.json" -Value '{"api_key":"PASTE_YOUR_KEY_HERE"}'
```

## Skill path
If the skill is installed under the default Codex skill directory:

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export VSIX_IMAGE_GEN_CLI="$CODEX_HOME/skills/vsix-image-gen/scripts/generate.js"
```

If the user installed the skill elsewhere, adjust the CLI path accordingly.

## CLI quick start
Square image:
```bash
node "$VSIX_IMAGE_GEN_CLI" \
  --prompt "A cinematic product photo of a transparent mechanical keyboard on brushed steel" \
  --size "1024x1024" \
  --out "./keyboard.png"
```

Portrait image with a size alias:
```bash
node "$VSIX_IMAGE_GEN_CLI" \
  --prompt "A manga-style city alley at night with warm neon signs" \
  --size "portrait"
```

4K landscape image saved to disk:
```bash
node "$VSIX_IMAGE_GEN_CLI" \
  --prompt "A realistic urban night street photo" \
  --size "4k" \
  --out "./street-4k.png"
```

Image-to-image with a local reference:
```bash
node "$VSIX_IMAGE_GEN_CLI" \
  --prompt "Turn this into a watercolor travel poster" \
  --image-url "/absolute/path/to/reference.png"
```

Image-to-image with multiple references:
```bash
node "$VSIX_IMAGE_GEN_CLI" \
  --prompt "Blend these references into a clean landing-page hero illustration" \
  --image-url "https://example.com/ref-1.jpg" \
  --image-url "/absolute/path/to/ref-2.webp"
```

## Decision rules
- Default to one image per request.
- Accept exact sizes `1024x1024`, `1024x1536`, `1536x1024`, `1536x864`, `864x1536`, `1920x1080`, `1080x1920`, `2048x2048`, `3840x2160`, `2160x3840`, `2160x2160`, and `auto`.
- Also accept helpful aliases: `1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `square`, `portrait`, `landscape`, `wide`, `vertical`, `2k`, `2k-landscape`, `2k-portrait`, `4k`, `4k-landscape`, `4k-portrait`, `4k-square`.
- When the user just says “帮我画” or “generate an image”, keep the default square size unless they clearly want wallpaper or banner proportions.
- When the user asks for 2K or 4K, pass the matching size alias and use `--out` so the returned image is saved as a file instead of streaming a large data URI into the chat or terminal.
- If VSIX returns a retryable upstream error for a high-resolution request, the CLI automatically retries at a smaller same-ratio size and resizes back to the requested output size when `--out` is set. This is especially useful for image-to-image requests with reference images.
- When the request is an edit or style transfer, preserve the user's reference images and only rewrite the prompt enough to make the transformation clear.

## Output conventions
- The CLI writes progress and errors to stderr.
- The final image artifact is printed to stdout.
- On success, prefer `--out` for agent workflows and return the saved file path to the user.
- Without `--out`, prefer returning the resulting URL directly to the user. If the API responds with `b64_json`, the CLI prints a `data:` URI instead.
