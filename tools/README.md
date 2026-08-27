# tools/

Scripts to (re)generate the bootloader / partition-table files in
[bin/boot/](../bin/boot/). See that folder's README first for what each
output file actually is - this one only covers how to produce them.

Nothing here runs as part of serving the site; these are maintainer tools,
run by hand whenever a new WLED release needs a new board's partition
layout or an upstream partition-table change picked up, or when a chip's
*canonical* reference bootloader itself needs regenerating (e.g. from a
fresh PlatformIO build). Flash-size fan-out for bootloaders - re-flagging
one canonical file for the *other* declared sizes - no longer happens here;
`app.js` does that client-side, in the browser, at install time (see
`patchBootloaderFlashSize` / `getPatchedBootloaderUrl` in
[../app.js](../app.js) and the "one bootloader file per chip" note in
[bin/boot/README.md](../bin/boot/README.md)). The `bootloader` subcommand
below is still how you'd produce/repair a canonical file itself; it's just
no longer run once per additional flash size.

## Setup

```bash
pip install esptool
```

`gen_boot_images.py`'s `partitions` subcommand has no dependencies (it's a
from-scratch reimplementation of ESP-IDF's partition-table binary format).
The `bootloader` and `merge` subcommands shell out to `esptool` in-process,
since it - not this script - owns the ESP image checksum/SHA-256 format.
Tested against esptool 5.3.1.

## Building a reference `bootloader.bin` from WLED source

Both the `bootloader` and `merge` subcommands need a real, chip-matched
`bootloader.bin` as input (see their sections below). The bootloader isn't
WLED-specific - it comes from the Arduino-ESP32 core, compiled as part of
any PlatformIO build for that chip - so the easiest source is just building
WLED itself once per chip:

```bash
git clone https://github.com/wled/WLED.git
cd WLED
pio run -e <env>
```

The output appears at `.pio/build/<env>/bootloader.bin` (and
`.pio/build/<env>/partitions.bin`, if you want to sanity-check a partition
CSV against a real build instead of using the `partitions` subcommand).

`<env>` just needs to target the right **chip**, not match the WLED release
variant/flash-size you're actually generating files for - the bootloader
doesn't change between WLED's Plain/Audioreactive/Ethernet/etc. builds, and
its flash-size field gets rewritten by `gen_boot_images.py` anyway. Picking
any env for that chip from `platformio.ini` works; as of this writing these
are the ones matching the chips/sizes used in `bin/boot/`:

| Chip | Mode | Env in WLED's `platformio.ini` |
|---|---|---|
| ESP32 | DIO (canonical) | `esp32dev` |
| ESP32 | QIO | *(no WLED env sets this - see "Building the non-default modes" below)* |
| ESP32-C3 | DIO (canonical) | `esp32c3dev` |
| ESP32-C3 | QIO | `esp32c3dev_qio` |
| ESP32-S2 | QIO (canonical) | `lolin_s2_mini` |
| ESP32-S2 | DIO | *(no WLED env sets this either)* |
| ESP32-S3 | QIO (canonical) | `esp32s3_4M_qspi` / `esp32s3dev_8MB_opi` / `esp32s3dev_16MB_opi` (any of these - all QIO) |
| ESP32-S3 | OPI | `esp32S3_wroom2_32MB` (the only WLED env with `board_build.arduino.memory_type = opi_opi`) |

Env names do move around between WLED releases - run `pio run -e nonexistent`
(it'll fail and list all valid envs) or check `platformio.ini` directly if
one of the above no longer exists. `pio` is PlatformIO Core's CLI
(`pip install platformio`, or use the one bundled with the PlatformIO IDE/VS
Code extension if you already have it installed for firmware work).

Like ESP32-S3, ESP32/ESP32-C3/ESP32-S2 now support 4MB/8MB/16MB in this
repo too - building any one flash size per chip is enough. That single
build becomes the chip's committed *canonical* bootloader; the other
declared sizes are re-flagged from it client-side, in the browser, at
install time (see [bin/boot/README.md](../bin/boot/README.md)) rather than
via a separate build or a `gen_boot_images.py` run per size. Flash *mode*
is different: it can't be re-flagged at all (client-side or otherwise), so
every mode needs its own real build from its own env, all committed - see
the "Flash mode" section in [bin/boot/README.md](../bin/boot/README.md) for
the full reasoning and the complete file list.

### Building the non-default modes

WLED's own `platformio.ini` only defines an env for each chip's *default*
mode, plus `esp32c3dev_qio` for the one real published override. To build
the others (ESP32 QIO, ESP32-S2 DIO - committed for completeness even
though no WLED firmware asset uses them, see
[bin/boot/README.md](../bin/boot/README.md)), add a `platformio_override.ini`
next to WLED's `platformio.ini` (PlatformIO loads it automatically if
present - see `platformio_override.sample.ini` in the WLED repo for the
format) with an env that extends the chip's default one and overrides just
the flash mode:

```ini
[env:esp32_qio]
extends = env:esp32dev
board_build.flash_mode = qio

[env:esp32s2_dio]
extends = env:lolin_s2_mini
board_build.flash_mode = dio
```

then `pio run -e esp32_qio` / `pio run -e esp32s2_dio` as usual. **Don't
bother trying this for QOUT, DOUT, or plain DIO on ESP32-S3** - the build
will fail with `fatal error: sdkconfig.h: No such file or directory`.
That's not a config mistake to work around; Arduino-ESP32 v3.x's
precompiled `esp32-arduino-libs` genuinely don't ship those combinations
(verify by listing
`~/.platformio/packages/framework-arduinoespressif32/tools/esp32-arduino-libs/<chip>/`
- confirmed empty of anything but `dio_qspi`/`qio_qspi` for ESP32/C3/S2,
and `qio_qspi`/`qio_opi`/`opi_opi` for S3, across every currently-installed
platform version at the time this was written). There's no way to produce
a real, trustworthy bootloader for those modes with this toolchain - see
[bin/boot/README.md](../bin/boot/README.md)'s "Flash mode" section for the
complete reasoning and the resulting file list.

For ESP32-S3's OPI mode specifically, don't add a scratch env - just use
`esp32S3_wroom2_32MB` directly, exactly as documented in the table above;
it already sets `board_build.arduino.memory_type = opi_opi`, which is what
actually determines the real boot mode (see `_get_board_boot_mode` /
`_get_board_flash_mode` in the espressif32 platform's `builder/main.py` -
`board_build.flash_mode` alone is not sufficient for octal-flash boards,
and gets silently overridden once `memory_type` is `opi_opi`/`opi_qspi`).

### Historical alternative: extracting a reference bootloader from a merged image

Before this repo built its own bootloaders from source, `bin/boot/` shipped
merged 4MB images for ESP32/ESP32-C3 with a real (but unverified-provenance)
bootloader flattened inside, and the canonical `bootloader_esp32_8m.bin` /
`bootloader_c3_8m.bin` were bootstrapped by slicing the bootloader region
back out of those (`data[0x1000:0x8000]` for ESP32, `data[0x0:0x8000]` for
ESP32-C3 - offsets matching each chip's real bootloader address and the
partition table's fixed `0x8000` start). Both merged images are gone now
(see [bin/boot/README.md](../bin/boot/README.md)'s "Regenerating these
files" section) and every canonical file is a real PlatformIO build - this
slicing trick no longer has anything to slice from, but is worth knowing
about if this repo (or a fork) ever ends up back in a state with a merged
image and no direct PlatformIO access. It's how the empirical flash-mode
finding above was eventually *disproven* as a reliable shortcut, for what
it's worth: a byte-for-byte-verified slice still can't tell you the real
compiled flash mode, only a fresh build's known source config can.

## `partitions` - build a partition table from a CSV

```bash
python tools/gen_boot_images.py partitions tools/partition_tables/s3_8m.csv \
    -o bin/boot/partitions/partitions_s3_8m.bin
```

[`partition_tables/`](partition_tables/) holds one CSV per `partitions_*.bin`
in `bin/boot/`, reverse-engineered from those files and verified to
reproduce them byte-for-byte (the 8MB/16MB CSVs for ESP32/ESP32-C3/ESP32-S2
are plain copies of the ESP32-S3 8MB/16MB layout - the partition table
format doesn't depend on chip family, only flash size). Standard ESP-IDF
partition-table CSV format: `Name, Type, SubType, Offset, Size`. To change a
layout (e.g. resize `spiffs`), edit the CSV and re-run this command - don't
hand-edit the `.bin`.

To add a new flash-size/board layout: copy the closest existing CSV, adjust
offsets/sizes, run the command above, and wire the new file into
`CHIP_CONFIG` / `HUB75_LAYOUTS` in [../app.js](../app.js).

## `bootloader` - re-flag a bootloader for a different flash size

Mainly useful now for producing/repairing a chip's *canonical* file itself
(e.g. re-flagging a fresh PlatformIO build to whatever size you want
committed as canonical) - the other declared flash sizes are no longer
generated this way, see the "one bootloader file per chip" note in
[bin/boot/README.md](../bin/boot/README.md).

```bash
python tools/gen_boot_images.py bootloader esp32s3 <path-to-bootloader.bin> \
    --flash-size 8MB --offset 0x0 -o bin/boot/bootloaders/esp32-s3/bootloader_s3.bin
```

`<path-to-bootloader.bin>` is a bootloader produced by actually building
WLED (or any Arduino-ESP32 sketch) for the target chip - e.g.
`.pio/build/<env>/bootloader.bin` after a PlatformIO build. This command
rewrites the flash-size header field to match `--flash-size`, recomputing
the checksum and appended SHA-256 digest to match (this is exactly what
`esptool.py write_flash` does at flash time - here it's done ahead of time,
since ESP Web Tools flashes bootloader files as-is; the same patch+rehash
also has a from-scratch JS port that runs client-side for the other flash
sizes, see [bin/boot/README.md](../bin/boot/README.md)). Same command for
other chips, just change `--chip`, `--offset`, `--flash-size`, and the
source/output:

```bash
python tools/gen_boot_images.py bootloader esp32c3 <path-to-bootloader.bin> \
    --flash-size 8MB --offset 0x0 -o bin/boot/bootloaders/esp32-c3/bootloader_c3_8m.bin
```

Non-default-mode files follow the same command, just built from a
different-mode source and given a `_<mode>` suffix (see
[bin/boot/README.md](../bin/boot/README.md)'s "Flash mode" section for the
full file list and which ones are wired into `app.js`):

```bash
python tools/gen_boot_images.py bootloader esp32 <path-to-qio-bootloader.bin> \
    --flash-size 8MB --offset 0x1000 -o bin/boot/bootloaders/esp32/bootloader_esp32_8m_qio.bin

python tools/gen_boot_images.py bootloader esp32s2 <path-to-dio-bootloader.bin> \
    --flash-size 4MB --offset 0x1000 -o bin/boot/bootloaders/esp32-s2/bootloader_s2_dio.bin
```

ESP32-S3's OPI file is committed as-is from the raw `esp32S3_wroom2_32MB`
build (already 32MB-flagged, which is the only size that board ships) -
re-flag it the same way as any other canonical file if a different size is
ever needed:

```bash
python tools/gen_boot_images.py bootloader esp32s3 .pio/build/esp32S3_wroom2_32MB/bootloader.bin \
    --flash-size 32MB --offset 0x0 -o bin/boot/bootloaders/esp32-s3/bootloader_s3_opi.bin
```

**`--offset` must be this chip's real bootloader flash offset** - `0x1000`
for ESP32/ESP32-S2, `0x0` for ESP32-S3/ESP32-C3 (and most other newer
chips) - not just "0x0 because that's where the output file's byte 0
goes." `esptool`'s `merge-bin` only patches the flash-size/checksum/hash
fields of the image it finds *at that chip's canonical bootloader offset*;
give it the wrong offset and it silently copies the input through
**unpatched, with no error or warning** - which is exactly the bug that
originally shipped `bootloader_esp32_8m.bin` and `bootloader_s2_8m.bin`
(a since-removed file, now derived client-side) still internally flagged as
4MB, and caused a boot loop on real 8MB ESP32 hardware (the ROM loads the
still-4MB bootloader fine, then the mismatch between what it thinks the
flash size is and the actual 8MB partition table crashes it before it can
print anything). Passing a nonzero `--offset` also makes `merge-bin`
prepend that many `0xFF` padding bytes to the output (since it assumes it's
building a full image starting at address 0) - this command strips that
padding back off afterwards so the file's byte 0 is still the real
bootloader, ready to be flashed starting at that offset as its own manifest
part.

Valid `--flash-size` values: `1MB`, `2MB`, `4MB`, `8MB`, `16MB`, `32MB`.

## `merge` - build a single-file boot image (bootloader + partitions + otadata)

**Not currently used** - every file in `bin/boot/` today uses the separate
bootloader/partition-table form instead (see
[bin/boot/README.md](../bin/boot/README.md)). ESP32 and ESP32-C3 used to
ship a merged 4MB image built this way (`esp32_bootloader_v4.bin` /
`esp32-c3_bootloader_v2(_qio).bin`); both were retired once re-flagging a
chip's canonical bootloader down to 4MB was verified trustworthy, same as
every other size - see the "Regenerating these files" section of
[bin/boot/README.md](../bin/boot/README.md) for the reasoning. Kept here in
case a merged single-part image is ever needed again - e.g. if a future
board/manifest genuinely needs `otadata` written explicitly (see the
`boot_app0.bin` note in that same README) rather than relying on the
blank-otadata-boots-`ota_0` fallback:

```bash
python tools/gen_boot_images.py merge esp32 --flash-size 4MB \
    -o esp32_bootloader_v4.bin \
    0x1000:<path-to-bootloader.bin> \
    0x8000:bin/boot/partitions/partitions_c3_4m.bin \
    0xe000:bin/boot/boot_app0.bin
```

```bash
python tools/gen_boot_images.py merge esp32c3 --flash-size 4MB \
    -o esp32-c3_bootloader_v2.bin \
    0x0:<path-to-c3-bootloader.bin> \
    0x8000:bin/boot/partitions/partitions_c3_4m.bin \
    0xe000:bin/boot/boot_app0.bin
```

`<path-to-bootloader.bin>` / `<path-to-c3-bootloader.bin>` again come from an
actual PlatformIO/Arduino build for that chip - note the bootloader offset
differs (`0x1000` for classic ESP32, `0x0` for ESP32-C3, since that's where
each chip's ROM loader expects it). `boot_app0.bin` is the standard
Arduino-ESP32 OTA-select seed file and doesn't need regenerating - copy it
from an existing Arduino-ESP32 install
(`~/.arduino15/packages/esp32/hardware/esp32/<ver>/tools/partitions/boot_app0.bin`)
or a PlatformIO one (`~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin`)
if you ever need a fresh copy.

`--flash-size` here plays the same role as in the `bootloader` subcommand:
`merge-bin` patches the bootloader segment's flash-size field to match
before flattening everything into one file.

## Why not just commit `.pio/build/<env>/{bootloader,partitions}.bin` directly?

You can, for the flash size you actually built - that's the natural source
of a reference bootloader for the `bootloader`/`merge` commands above, and
partition tables can equally be produced by an ESP-IDF/PlatformIO build
rather than by the `partitions` subcommand. This script exists so the
partition CSVs are tracked as reviewable source rather than only as opaque
binaries, and (for `bootloader`/`merge`) so a canonical bootloader can be
re-flagged to whatever size you want committed without needing a
board/env for that exact size. Flash-size fan-out across a chip's *other*
declared sizes isn't this script's job anymore - see the client-side
patcher note in [bin/boot/README.md](../bin/boot/README.md).
