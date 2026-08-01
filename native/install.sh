#!/usr/bin/env bash
# Registers the Taildrop bridge as a Chrome native messaging host.
#
#   ./install.sh <extension-id> [py|js]
#
# The extension id is shown on the extension card at chrome://extensions with
# developer mode on. For an unpacked extension the id changes if you move the
# folder — re-run this script if that happens.
#
# Runtime defaults to py: python3 ships with macOS, node does not.
set -euo pipefail

EXT_ID="${1:-}"
RUNTIME="${2:-py}"
if [ -z "$EXT_ID" ]; then
  echo "Использование: ./install.sh <id расширения из chrome://extensions> [py|js]" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$RUNTIME" in
  py) HOST_PY="$HERE/triangle_taildrop.py" ;;
  js)
    HOST_PY="$HERE/triangle_taildrop.js"
    command -v node >/dev/null 2>&1 || { echo "node не найден — поставьте Node или используйте py" >&2; exit 1; }
    ;;
  *) echo "Неизвестная среда: $RUNTIME (ожидается py или js)" >&2; exit 1 ;;
esac
chmod +x "$HOST_PY"
echo "Помощник: $HOST_PY"

NAME="com.triangle.taildrop"

# Chrome, Chromium, Brave and Edge each read their own directory.
DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
)

wrote=0
for d in "${DIRS[@]}"; do
  parent="$(dirname "$d")"
  [ -d "$parent" ] || continue
  mkdir -p "$d"
  cat > "$d/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Triangle Downloader — Taildrop bridge",
  "path": "$HOST_PY",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "→ $d/$NAME.json"
  wrote=$((wrote+1))
done

if [ "$wrote" -eq 0 ]; then
  echo "Не найден ни один браузер на основе Chromium." >&2
  exit 1
fi

if command -v tailscale >/dev/null 2>&1 || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  echo "Tailscale CLI найден."
else
  echo "ВНИМАНИЕ: CLI tailscale не найден. Нужна версия с tailscale.com или из Homebrew —" >&2
  echo "сборка из App Store не умеет 'tailscale file cp'." >&2
fi

echo "Готово. Перезапустите браузер, чтобы он подхватил хост."
