#!/usr/bin/env python3
"""Regenerate build-info.json from the current git state.

index.html's footer fetches build-info.json at page load to show when this
copy of the site was last built - useful for telling a stale cached/deployed
page apart from a fresh one. There's no build step or CI in this repo, so
nothing produces that file automatically; run this manually before testing
or deploying, or wire it into a post-commit hook (see tools/README.md) so it
never goes stale.
"""
import json
import subprocess
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "build-info.json"


def git(*args):
    return subprocess.run(
        ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()


def main():
    info = {
        "builtAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "commit": git("rev-parse", "--short", "HEAD"),
        "dirty": bool(git("status", "--porcelain")),
    }
    OUTPUT.write_text(json.dumps(info, indent=2) + "\n")
    print(f"wrote {OUTPUT.relative_to(REPO_ROOT)}: {info}")


if __name__ == "__main__":
    main()
