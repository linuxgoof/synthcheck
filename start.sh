#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create venv if missing
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# Install / upgrade dependencies
echo "Installing dependencies..."
pip install --upgrade pip -q
pip install -r requirements.txt -q

echo ""
echo "======================================"
echo "  SynthCheck — AI Content Detector"
echo "  http://localhost:8000"
echo "======================================"
echo ""
echo "Note: On first launch the models will be"
echo "downloaded from HuggingFace (~1-2 GB)."
echo ""

exec python app.py
