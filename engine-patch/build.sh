#!/usr/bin/env bash
# Rebuilds MonarchMouse.dll and the patched Monarch.exe at the top of the repository.
#
#   engine-patch/build.sh [unpatched Monarch.exe]
#
# Without an argument it patches the unpatched 0.6.2 Monarch.exe from git history (commit 5f44508).
# Needs the .NET 8 SDK; works on Windows (Git Bash), Linux and macOS.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ $# -ge 1 ]; then cp "$1" "$work/Monarch.exe"
else git -C "$repo" show 5f44508:Monarch.exe > "$work/Monarch.exe"
fi
cp "$repo"/*.dll "$work/" 2>/dev/null || true
rm -f "$work/MonarchMouse.dll"

dotnet build "$here/MonarchMouse/MonarchMouse.csproj" -c Release -o "$work/mm" --artifacts-path "$work/a1" -v quiet -nologo
dotnet build "$here/Patcher/Patcher.csproj" -c Release -o "$work/patcher" --artifacts-path "$work/a2" -v quiet -nologo
dotnet "$work/patcher/Patcher.dll" "$work/Monarch.exe" "$work/mm/MonarchMouse.dll" "$work/out.exe"

cp "$work/out.exe" "$repo/Monarch.exe"
cp "$work/mm/MonarchMouse.dll" "$repo/MonarchMouse.dll"
echo "Updated Monarch.exe and MonarchMouse.dll in $repo"
