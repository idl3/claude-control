#!/bin/bash
# claude-control setup — install local dependencies for voice transcription.
#
# Whisper.cpp is NOT bundled. The 🎤 voice input needs three things, all local
# (no API key, no cloud): ffmpeg, the whisper-cli binary (Homebrew `whisper-cpp`),
# and a ggml model under ~/.claude-control/models. This installs/downloads them
# idempotently. tmux (required to run the app at all) is checked too.
set -uo pipefail

MODELS_DIR="$HOME/.claude-control/models"
MODEL="ggml-base.en.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

say "claude-control setup — local dependencies"

# tmux — required for the app itself (sessions live in tmux).
if command -v tmux >/dev/null 2>&1; then ok "tmux: $(command -v tmux)"; else
  bad "tmux not found (required). Install: brew install tmux"
fi

# Homebrew — the install path for ffmpeg + whisper-cpp on macOS.
if ! command -v brew >/dev/null 2>&1; then
  bad "Homebrew not found. Install it from https://brew.sh, then re-run: claude-control setup"
  exit 1
fi

say "Installing ffmpeg + whisper-cpp (Homebrew, skips if already present)…"
brew install ffmpeg whisper-cpp || {
  bad "brew install failed — see output above"
  exit 1
}

say "Whisper model (~150 MB, base.en)…"
mkdir -p "$MODELS_DIR"
if ls "$MODELS_DIR"/ggml-*.bin >/dev/null 2>&1; then
  ok "model already present: $(ls "$MODELS_DIR"/ggml-*.bin | head -1)"
else
  echo "  downloading $MODEL → $MODELS_DIR"
  if curl -fL --progress-bar "$MODEL_URL" -o "$MODELS_DIR/$MODEL.partial"; then
    mv "$MODELS_DIR/$MODEL.partial" "$MODELS_DIR/$MODEL"
    ok "downloaded $MODEL"
  else
    rm -f "$MODELS_DIR/$MODEL.partial"
    bad "model download failed — check your connection and re-run"
    exit 1
  fi
fi

say "Verifying voice-transcription chain…"
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg: $(command -v ffmpeg)" || bad "ffmpeg missing"
command -v whisper-cli >/dev/null 2>&1 && ok "whisper-cli: $(command -v whisper-cli)" || bad "whisper-cli missing (brew install whisper-cpp)"
ls "$MODELS_DIR"/ggml-*.bin >/dev/null 2>&1 && ok "model: $(ls "$MODELS_DIR"/ggml-*.bin | head -1)" || bad "no ggml model in $MODELS_DIR"

say "Done. The 🎤 mic (voice → text) is ready."
echo "  Note: the MLX prompt-enhancer (optional) is separate; the optimiser falls"
echo "  back to claude -p / rules when MLX isn't set up."
