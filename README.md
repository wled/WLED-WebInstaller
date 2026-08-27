# WLED Web Installer

A static, GitHub-Pages-friendly web installer for [WLED](https://github.com/wled/WLED), built on
[ESP Web Tools](https://esphome.github.io/esp-web-tools/).

No build step and no server component: `index.html` fetches the release list straight from the
GitHub Releases API at page-load time and generates an install manifest on the fly for whichever
version / variant / flash size combination the user picks.

## Features

- Always up to date - versions come live from the [wled/WLED releases](https://github.com/wled/WLED/releases) API, no manual manifest maintenance.
- Variant selection (Plain, Audioreactive, Ethernet, ESP8266 CPU frequency test, ESP32 V4, DEBUG, HUB75 Matrix) - variants unavailable for the selected version stay visible but disabled.
- Flash size selection (1MB / 2MB / 4MB / 8MB / 16MB) for ESP32, ESP32-C3, ESP32-S2, ESP32-S3, and ESP8266 - sizes unavailable for the selected version/variant stay visible but disabled.
- HUB75 layout selection (board/pinout picker) when the HUB75 Matrix variant is selected.
- Multi-language UI, loaded dynamically from `lang/` - see [Localization](#localization).

## Local development

Any static file server works, e.g.:

```bash
npx serve .
```

Then open the printed local URL in Chrome or Edge (Web Serial is required).

Run `python tools/update_build_info.py` once beforehand (and again after any change you want to
see reflected) to populate the "Installer build:" line in the footer - see
[Build info](#build-info) below.

## Deploying

Two ways to host this on GitHub Pages:

- **GitHub Actions (recommended)** - [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
  regenerates `build-info.json` fresh and publishes the repository root on every push to `master`
  (or on demand via "Run workflow"). One-time setup: repo Settings -> Pages -> Build and
  deployment -> Source -> **GitHub Actions**. With this method the footer's build info is always
  accurate for whatever's actually deployed - no manual step, no committed generated file.
- **Deploy from branch** - Settings -> Pages -> Build and deployment -> Source -> **Deploy from a
  branch**. Simpler, no workflow runs, but nothing regenerates `build-info.json` for you - see
  [Build info](#build-info) if you want the footer populated under this method too.

Either way, no build step is required for the site itself - the repository root is the site as-is.

## Localization

`lang/languages.json` maps each supported language code to its display name, and
`lang/<code>.json` holds that language's strings. Both are fetched at runtime - `i18n.js` never
hardcodes a language list.

To add a language:

1. Copy `lang/en.json` to `lang/<code>.json` (e.g. `lang/de.json`) and translate the values.
2. Add one line to `lang/languages.json`: `"<code>": "<Native display name>"`.

That's it - the language selector and every `data-i18n` element on the page pick it up on next
load, no code changes required. Missing keys in a translation silently fall back to English.

## Build info

The footer shows when this copy of the site was last built (date/time + short commit hash, with
a `+` suffix if the working tree had uncommitted changes) - handy for confirming you're not
looking at a stale cached or deployed copy. It reads `build-info.json`.

**If deploying via the GitHub Actions workflow** (see [Deploying](#deploying)), this is fully
automatic - the workflow regenerates it fresh on every deploy, and it's never committed to the
repository at all (each deploy's artifact just carries its own current copy).

**For local testing, or if deploying via "Deploy from branch"** instead, nothing regenerates it
for you - `build-info.json` isn't committed by default, so the footer line just stays hidden until
you run:

```bash
python tools/update_build_info.py
```

To have that happen automatically on every commit rather than remembering to run it by hand
(useful for the "Deploy from branch" case, or just for local testing convenience), opt into the
repo's hook once with:

```bash
git config core.hooksPath .githooks
```

## Files

- `index.html`, `style.css` - page markup/styling.
- `app.js` - release fetching, manifest generation, UI wiring.
- `i18n.js` - loads `lang/` and applies translations.
- `lang/` - one JSON file per language, plus `languages.json` listing them.
- `bin/boot/` - chip bootloaders and partition tables needed to flash bare chips (WLED release assets only contain the application binary); see [bin/boot/README.md](bin/boot/README.md) for what each file is.
- `tools/` - maintainer scripts: `gen_boot_images.py` (re)generates the files in `bin/boot/` (see [tools/README.md](tools/README.md)); `update_build_info.py` regenerates `build-info.json` (see [Build info](#build-info)).
- `.githooks/post-commit` - optional hook that keeps `build-info.json` current after every commit; not active until you run the `git config core.hooksPath` command above.
- `.github/workflows/deploy-pages.yml` - builds `build-info.json` and publishes to GitHub Pages; see [Deploying](#deploying).

## License

MIT, see `LICENSE`.
