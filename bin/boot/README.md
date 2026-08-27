# bin/boot/

A WLED release asset (e.g. `WLED_0.15.0_ESP32.bin`) is the **application only**
- it does not contain a 2nd-stage bootloader or a partition table, and flashing
it alone to a bare/erased chip will not boot. Real hardware also needs, at
minimum:

- a **2nd-stage bootloader** (ESP32 ROM loads this first; it in turn loads the
  application),
- a **partition table** (tells the bootloader where the app, NVS, SPIFFS, etc.
  live in flash),
- and usually **OTA select data** ("otadata" - tells the bootloader which of
  the two OTA app slots to boot).

Upstream WLED doesn't publish these separately per chip/flash-size as release
assets, so this repo ships its own copies here and [app.js](../../app.js)
flashes them alongside the firmware binary, at the correct offsets, as
additional parts of the same [ESP Web Tools](https://esphome.github.io/esp-web-tools/)
manifest. See `CHIP_CONFIG` / `HUB75_LAYOUTS` in app.js for exactly which
files are used for which chip/flash-size combination.

## Layout

```
bin/boot/
  boot_app0.bin
  bootloaders/
    esp32/       bootloader_esp32_8m.bin, bootloader_esp32_8m_qio.bin
    esp32-c3/    bootloader_c3_8m.bin, bootloader_c3_8m_qio.bin
    esp32-s2/    bootloader_s2.bin, bootloader_s2_dio.bin
    esp32-s3/    bootloader_s3.bin, bootloader_s3_opi.bin
  partitions/
    partitions_*.bin  (one per chip x flash size, flat - see table below)
```

`bootloaders/<chip>/` groups each chip family's canonical bootloader(s)
(and, for ESP32-C3, its flash-mode override - see "Flash mode" below);
`partitions/` holds every partition table flat, since several of them are
already shared/identical across chip families (see the note below the
table) rather than belonging to one chip folder. `app.js` builds these
paths from two small constants, `bootloaderBase` and `partitionBase`
(derived from `bootBase`) - update those, not individual file paths, if
this layout ever changes again.

Every chip/flash-size combination uses the same shape: a 2nd-stage
bootloader and a partition table, flashed as two distinct manifest parts
(no merged/flattened single-file form - see "Regenerating these files"
below for why one used to exist and was removed).

| File | Chip | Flash size | Offset | What it is |
|---|---|---|---|---|
| *(none - patched client-side)* | ESP32-S2 | 4MB | `0x1000` | `bootloaders/esp32-s2/bootloader_s2.bin` re-flagged for 4MB flash, computed in the browser at install time |
| `partitions/partitions_s2_4m.bin` | ESP32-S2 | 4MB | `0x8000` | Partition table |
| `bootloaders/esp32-s2/bootloader_s2.bin` | ESP32-S2 | 8MB | `0x1000` | 2nd-stage bootloader (**canonical** reference for this chip) |
| `partitions/partitions_s2_8m.bin` | ESP32-S2 | 8MB | `0x8000` | Partition table |
| *(none - patched client-side)* | ESP32-S2 | 16MB | `0x1000` | `bootloaders/esp32-s2/bootloader_s2.bin` re-flagged for 16MB flash, computed in the browser at install time |
| `partitions/partitions_s2_16m.bin` | ESP32-S2 | 16MB | `0x8000` | Partition table |
| *(none - patched client-side)* | ESP32-S3 | 4MB | `0x0` | `bootloaders/esp32-s3/bootloader_s3.bin` re-flagged for 4MB flash, computed in the browser at install time |
| `partitions/partitions_s3_4m.bin` | ESP32-S3 | 4MB | `0x8000` | Partition table |
| `bootloaders/esp32-s3/bootloader_s3.bin` | ESP32-S3 | 8MB | `0x0` | 2nd-stage bootloader (**canonical** reference for this chip) |
| `partitions/partitions_s3_8m.bin` | ESP32-S3 | 8MB | `0x8000` | Partition table |
| *(none - patched client-side)* | ESP32-S3 | 16MB | `0x0` | `bootloaders/esp32-s3/bootloader_s3.bin` re-flagged for 16MB flash, computed in the browser at install time |
| `partitions/partitions_s3_16m.bin` | ESP32-S3 | 16MB | `0x8000` | Partition table |
| *(none - patched client-side)* | ESP32-S3 | 32MB | `0x0` | `bootloaders/esp32-s3/bootloader_s3_opi.bin` re-flagged for 32MB flash, computed in the browser at install time (see "Flash mode" below - this specific board needs a genuinely different bootloader, not just a different size) |
| `partitions/partitions_s3_32m.bin` | ESP32-S3 | 32MB | `0x8000` | Partition table |
| `partitions/partitions_s3_hdwf2.bin` | ESP32-S3 (Huidu HD-WF2) | 4MB | `0x8000` | Partition table (paired with `bootloader_s3.bin`, not the 4MB-patched one) |
| *(none - patched client-side)* | ESP32 | 4MB | `0x1000` | `bootloaders/esp32/bootloader_esp32_8m.bin` re-flagged for 4MB flash, computed in the browser at install time |
| `bootloaders/esp32/bootloader_esp32_8m.bin` | ESP32 | 8MB | `0x1000` | 2nd-stage bootloader (**canonical** reference for this chip) |
| `partitions/partitions_esp32_8m.bin` | ESP32 | 8MB | `0x8000` | Partition table |
| *(none - patched client-side)* | ESP32 | 16MB | `0x1000` | `bootloaders/esp32/bootloader_esp32_8m.bin` re-flagged for 16MB flash, computed in the browser at install time |
| `partitions/partitions_esp32_16m.bin` | ESP32 | 16MB | `0x8000` | Partition table |
| *(none - patched client-side)* | ESP32-C3 | 4MB | `0x0` | `bootloaders/esp32-c3/bootloader_c3_8m.bin` (or `_qio.bin`) re-flagged for 4MB flash, computed in the browser at install time |
| `bootloaders/esp32-c3/bootloader_c3_8m.bin` | ESP32-C3 | 8MB | `0x0` | 2nd-stage bootloader, DIO (**canonical** reference for this chip - see flash-mode note below) |
| `bootloaders/esp32-c3/bootloader_c3_8m_qio.bin` | ESP32-C3 | 8MB | `0x0` | 2nd-stage bootloader, QIO (flash-mode override - see below) |
| `partitions/partitions_c3_8m.bin` | ESP32-C3 | 8MB | `0x8000` | Partition table |
| *(none - patched client-side)* | ESP32-C3 | 16MB | `0x0` | `bootloaders/esp32-c3/bootloader_c3_8m.bin` (or `_qio.bin`) re-flagged for 16MB flash, computed in the browser at install time |
| `partitions/partitions_c3_16m.bin` | ESP32-C3 | 16MB | `0x8000` | Partition table |

ESP32 and ESP32-C3's 4MB size reuses `partitions/partitions_c3_4m.bin` as
its partition table rather than a chip-specific `partitions_esp32_4m.bin` /
second copy of `partitions_c3_4m.bin` - this 4MB layout is byte-identical
across every chip family (same as the 8MB/16MB layouts, which really are
shared files already), so there was never a reason to duplicate it, just a
slightly inconsistent naming precedent from when the merged 4MB images
(see below) were the only thing using it. This sharing is exactly why
partition tables live in one flat `partitions/` folder instead of being
split per chip like the bootloaders are.

Note there's no `boot_app0.bin`-equivalent part flashed for any of these -
same reasoning as below: blank `otadata` falls back to booting `ota_0`.

**Why only one bootloader file per chip now, instead of one per flash
size:** an ESP32-family bootloader image header has the flash size baked
into it (one nibble of one byte), plus a SHA-256 digest appended over the
whole image on every chip used here. The chip's ROM reads the flash-size
field to configure SPI flash before it can even find the partition table,
so a bootloader flagged for the wrong flash size can fail to boot.
`esptool.py write_flash` normally patches both fields for you at flash time
to match whatever `--flash_size` you pass it - but ESP Web Tools (which
this site uses, since it flashes over Web Serial from the browser) does
**not** do that patching, it writes each manifest part's bytes as-is. This
repo used to work around that by shipping one pre-patched-and-re-signed
bootloader per flash size per chip (generated via `tools/gen_boot_images.py`,
which shells out to `esptool`). It now instead ships a single **canonical**
bootloader per chip and re-flags it for the other declared sizes on the fly
in the browser, at install time - see `patchBootloaderFlashSize` /
`getPatchedBootloaderUrl` in [../../app.js](../../app.js), which reimplements
the same header-nibble-patch + SHA-256-recompute `esptool` does, using the
Web Crypto API, and is verified to reproduce every bootloader file this repo
used to ship byte-for-byte from its chip's canonical file. The image's
checksum byte (which covers only segment data, never the header) doesn't
need recomputing - only the header nibble and the digest do.
`tools/gen_boot_images.py`'s `bootloader` subcommand still exists and is
still the right tool for regenerating a chip's *canonical* file itself (e.g.
from a fresh PlatformIO build at a different flash size than what's
currently committed) - see [tools/README.md](../../tools/README.md).

`partitions_s3_hdwf2.bin` is paired with the plain 8MB-flagged
`bootloader_s3.bin` rather than a size-matched one - this looks wrong (the
board is physically 4MB) but it's what WLED's own upstream build config for
that board does, so it's replicated here rather than "corrected".

`bootloader_esp32_8m.bin` and `bootloader_c3_8m.bin` used to be a few KB
larger than their same-size ESP32-S2/S3 counterparts, bootstrapped by
extracting the bootloader region out of a merged bootloader+partitions+
otadata image (see "Regenerating these files" below) rather than from a
fresh PlatformIO build. Both are now fresh, from-source PlatformIO builds
like every other canonical file here, with no leftover padding.

## Flash mode

Flash *size* is a header nibble (see above) - flash *mode* (DIO/QIO/DOUT/
QOUT/OPI) is not. It's baked into the bootloader's **compiled** SPI-flash
init logic (from its own build's `board_build.flash_mode`, or - for octal
flash boards - `board_build.boot`), not a byte the client-side size-patcher
(or `esptool`) can flip. Confirmed empirically while building the files
here: the DIO and QIO builds' image *headers* report the identical
(conservative) mode byte despite being genuinely different compiled
binaries - the header cannot be used to tell them apart, only a real
PlatformIO build targeting each mode can produce a correct one. This is why
every bootloader file here is a **fresh, unmodified PlatformIO build
output** (via `tools/gen_boot_images.py`'s `bootloader`/`merge`
subcommands, which only ever touch the flash-*size* field - see
[tools/README.md](../../tools/README.md)), not something hand-patched for
mode.

**What's actually buildable.** WLED's real toolchain - Arduino-ESP32 v3.x's
precompiled `esp32-arduino-libs` - only ships sdkconfig variants for a
narrow set of flash-mode combinations (confirmed by inspecting
`~/.platformio/packages/framework-arduinoespressif32/tools/esp32-arduino-libs/<chip>/`
after every other combination failed to build with `fatal error:
sdkconfig.h: No such file or directory`):

| Chip | Buildable modes |
|---|---|
| ESP32 / ESP32-C3 / ESP32-S2 | DIO, QIO only |
| ESP32-S3 | QIO (quad flash), QIO+octal-PSRAM ("qio_opi" - same bootloader as plain QIO, PSRAM bus width doesn't touch bootloader logic), OPI (octal flash + octal PSRAM, "opi_opi") - **no plain DIO** |

QOUT and DOUT aren't buildable *at all*, on any chip - Espressif/Arduino
never shipped precompiled framework libraries for them in the modern
toolchain, so there's no way to produce a real, verified bootloader for
those modes the same trustworthy way every other file here was produced
(this repo won't hand-patch or fabricate one just to fill out the matrix -
see the "header alone can't tell you the real mode" point above for why
that would be worse than useless). So the file set below is the complete,
real set for every chip, not an arbitrary subset:

| File | Chip | Mode | Paired WLED release asset? |
|---|---|---|---|
| `bootloaders/esp32/bootloader_esp32_8m.bin` | ESP32 | DIO | Yes - `WLED_x.x.x_ESP32.bin` (**canonical**, used by default) |
| `bootloaders/esp32/bootloader_esp32_8m_qio.bin` | ESP32 | QIO | **No** - WLED only ever publishes DIO for this chip; committed for completeness/future use, not wired into any manifest |
| `bootloaders/esp32-c3/bootloader_c3_8m.bin` | ESP32-C3 | DIO | Yes - `WLED_x.x.x_ESP32-C3.bin` (**canonical**, used by default - also required to match the bootloader for in-place OTA from older WLED versions that used DIO) |
| `bootloaders/esp32-c3/bootloader_c3_8m_qio.bin` | ESP32-C3 | QIO | Yes - `WLED_x.x.x_ESP32-C3-QIO.bin` (flash-mode override, see the Flash mode row in the UI / `FLASH_MODE_ASSETS` in `app.js`) |
| `bootloaders/esp32-s2/bootloader_s2.bin` | ESP32-S2 | QIO | Yes - `WLED_x.x.x_ESP32-S2.bin` (**canonical**, used by default) |
| `bootloaders/esp32-s2/bootloader_s2_dio.bin` | ESP32-S2 | DIO | **No** - WLED only ever publishes QIO for this chip; committed for completeness/future use, not wired into any manifest |
| `bootloaders/esp32-s3/bootloader_s3.bin` | ESP32-S3 | QIO | Yes - every S3 release asset except the Waveshare/WROOM-2 one (**canonical**, used by default) |
| `bootloaders/esp32-s3/bootloader_s3_opi.bin` | ESP32-S3 | OPI | Yes - `WLED_x.x.x_ESP32-S3_Waveshare_HUB75.bin` / `..._WROOM-2.bin` (real octal-flash boot; used by the Waveshare HUB75 layout, re-flagged to 32MB client-side same as any other size - see `HUB75_LAYOUTS` in `app.js`) |

ESP32-C3's DIO/QIO pair is the only one exposed as a **UI** flash-mode
override, because it's the only one where WLED actually publishes both
modes as separate firmware assets - pairing a different-mode bootloader
with an app that was built for a different mode is exactly the kind of
mismatch this whole flash-mode investigation exists to avoid (see
`HANDOFF_flash_mode.md` in the repo root). The ESP32/ESP32-S2 QIO/DIO
"extra" files above exist purely so the *bootloader* side of the matrix is
complete and ready if WLED ever publishes a matching firmware variant for
them - there's currently nothing to pair them with, so `app.js` doesn't
reference them. ESP32-S3's OPI file, by contrast, already has a real,
currently-shipping firmware asset to pair with (the Waveshare board
genuinely needs octal-flash boot, unlike every other S3 board here, which
only differs in *PSRAM* bus width - something the bootloader doesn't care
about), so it's fully wired up.

## `boot_app0.bin`

The standard Arduino-ESP32 OTA-select seed file (8192 bytes) that gets
written to the `otadata` partition (offset `0xe000`, size `0x2000`) to tell
the bootloader "boot from OTA slot 0 (`app0`)". It's the same file
Arduino/PlatformIO writes at that offset for every ESP32 Arduino project.

It is **not currently referenced by app.js** for any manifest - every
chip/flash-size combination here uses the separate-files form above, and
none of those write `otadata` explicitly. This is not a bug: when `otadata`
is left blank/erased, the ESP-IDF bootloader falls back to booting the
first valid OTA slot (`ota_0`) by default, so writing it explicitly is a
nice-to-have (a deterministic OTA state from the first boot) rather than a
requirement. It's kept here in case a future manifest wants to flash it
(`tools/gen_boot_images.py`'s `merge` subcommand still knows how to embed
it into a flattened image, if that's ever needed again - see
[tools/README.md](../../tools/README.md)).

## Regenerating these files

See [../../tools/](../../tools/) for a script that rebuilds every file in
this folder from source (partition-table CSVs plus a bootloader built for
one reference flash size), along with the reasoning and the exact commands.
That script produces each chip's *canonical* bootloader file (and the
partition tables); every other flash-size bootloader variant is derived
from the canonical file client-side instead of being committed here - see
the "one bootloader file per chip" note above.

ESP32 and ESP32-C3 used to instead ship a separate **merged** boot image
for their 4MB size specifically (`esp32_bootloader_v4.bin` /
`esp32-c3_bootloader_v2(_qio).bin` - bootloader + partition table + otadata
flattened into one 64KB file, flashed as a single manifest part at offset
`0x0`). That predated 8MB/16MB support for these chips and was kept
un-migrated for a while to avoid touching a working, already-shipped path;
once flash-size re-flagging (both the pre-baked and later the client-side
versions) was verified trustworthy for every other size on every other
chip, the same reasoning applied equally to these two chips' 4MB case, so
the merged images were removed in favor of re-flagging
`bootloader_esp32_8m.bin` / `bootloader_c3_8m(_qio).bin` down to 4MB - one
fewer shape of file to reason about, with no behavior difference (blank
`otadata` either way, per the `boot_app0.bin` note above).
`tools/gen_boot_images.py`'s `merge` subcommand that built those images is
still there and still works, in case a merged image is ever needed again.
