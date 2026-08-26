#!/usr/bin/env python3
"""Regenerate the files in bin/boot/.

Three independent things live in bin/boot/, and this script has one
subcommand per thing - see tools/README.md for the full background on why
each file exists and how these subcommands were derived (every code path
below was checked byte-for-byte against the files currently in bin/boot/).

  partitions   CSV -> partition-table .bin (pure Python, no dependencies).
  bootloader   Re-flag an existing bootloader .bin for a different flash
               size (wraps esptool, which owns the checksum/SHA-256 format).
  merge        Flatten bootloader + partition-table + otadata into one
               "merged" boot image flashable as a single part at offset 0
               (also wraps esptool).

Examples
--------
Regenerate a partition table from its CSV:

    python tools/gen_boot_images.py partitions tools/partition_tables/s3_8m.csv \\
        -o bin/boot/partitions/partitions_s3_8m.bin

Re-flag a freshly built 8MB ESP32-S3 bootloader for 4MB/16MB boards. Note
--offset: it's this chip's real bootloader flash offset (0x1000 for
esp32/esp32s2, 0x0 for esp32s3/esp32c3/etc.) - esptool only patches the
flash-size field of the image it finds AT that offset, so getting it wrong
silently produces an unpatched, unflagged output with no error message:

    python tools/gen_boot_images.py bootloader esp32s3 bootloader.bin \\
        --flash-size 4MB --offset 0x0 -o bin/boot/bootloader_s3_4m.bin

Build the single merged boot image used for ESP32 / ESP32-C3 (bootloader +
partition table + OTA seed, flattened to one file flashed at offset 0):

    python tools/gen_boot_images.py merge esp32 --flash-size 4MB \\
        -o bin/boot/esp32_bootloader_v4.bin \\
        0x1000:bootloader.bin 0x8000:bin/boot/partitions/partitions_c3_4m.bin 0xe000:bin/boot/boot_app0.bin
"""
import argparse
import hashlib
import struct
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# `partitions`: ESP-IDF partition-table CSV -> .bin
#
# Reimplements the on-disk format of ESP-IDF's gen_esp32part.py (32-byte
# entries, magic 0xAA50, MD5 trailer with magic 0xEBEB, padded to 0xC00
# bytes) rather than depending on it, since that script ships with ESP-IDF /
# arduino-esp32, not with a pip package. Verified to reproduce every
# partitions_*.bin in bin/boot/ byte-for-byte from the CSVs in
# tools/partition_tables/.
# ---------------------------------------------------------------------------

PARTITION_TABLE_SIZE = 0xC00
MAGIC_BYTES = b"\xAA\x50"
MD5_MAGIC_BYTES = b"\xEB\xEB"

TYPES = {"app": 0x00, "data": 0x01}
APP_SUBTYPES = {"factory": 0x00, **{f"ota_{i}": 0x10 + i for i in range(16)}, "test": 0x20}
DATA_SUBTYPES = {
    "ota": 0x00, "phy": 0x01, "nvs": 0x02, "coredump": 0x03,
    "nvs_keys": 0x04, "efuse": 0x05, "undefined": 0x06,
    "esphttpd": 0x80, "fat": 0x81, "spiffs": 0x82,
}


def _parse_number(value):
    return int(value.strip(), 0)


def parse_partition_csv(path):
    rows = []
    for line in Path(path).read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        name, type_, subtype, offset, size, *rest = (c.strip() for c in line.split(","))
        flags = 1 if rest and rest[0].lower() == "encrypted" else 0
        rows.append((name, type_, subtype, _parse_number(offset), _parse_number(size), flags))
    return rows


def build_partition_table(rows, table_size=PARTITION_TABLE_SIZE):
    entries = bytearray()
    for name, type_, subtype, offset, size, flags in rows:
        if type_ not in TYPES:
            raise ValueError(f"unknown partition type {type_!r} for {name!r}")
        type_id = TYPES[type_]
        subtype_map = APP_SUBTYPES if type_ == "app" else DATA_SUBTYPES
        if subtype not in subtype_map:
            raise ValueError(f"unknown subtype {subtype!r} for {name!r}")
        label = name.encode("ascii")[:16].ljust(16, b"\x00")
        entries += MAGIC_BYTES
        entries += struct.pack("<BBII", type_id, subtype_map[subtype], offset, size)
        entries += label
        entries += struct.pack("<I", flags)

    md5 = hashlib.md5(bytes(entries)).digest()
    entries += MD5_MAGIC_BYTES + (b"\xFF" * 14) + md5

    if len(entries) > table_size:
        raise ValueError(f"partition table too large: {len(entries)} > {table_size} bytes")
    entries += b"\xFF" * (table_size - len(entries))
    return bytes(entries)


def cmd_partitions(args):
    rows = parse_partition_csv(args.csv)
    table = build_partition_table(rows)
    Path(args.output).write_bytes(table)
    print(f"wrote {len(table)} bytes to {args.output} ({len(rows)} partitions)")


# ---------------------------------------------------------------------------
# `bootloader` / `merge`: everything that touches the ESP image header
# (flash-size field, checksum, appended SHA-256 digest) is delegated to
# esptool - it is the tool that owns that format, and esp-web-tools does
# NOT do this patching itself (see the comment in app.js), which is why
# bin/boot/ ships one pre-patched bootloader per flash size instead of a
# single one that esp-web-tools could reuse.
# ---------------------------------------------------------------------------


def _run_esptool(argv):
    try:
        import esptool
    except ImportError:
        sys.exit(
            "esptool is required for this subcommand: pip install esptool"
        )
    esptool.main(argv)


def cmd_bootloader(args):
    # merge-bin only patches the flash-size/mode/freq header fields (and the
    # appended SHA-256 digest) of an image if it's the one located at this
    # chip's real bootloader offset - so we have to pass that offset, not
    # 0x0, for esptool to actually do anything. But merge-bin's job is to
    # build a full image starting at address 0, so passing a nonzero offset
    # makes it prepend that many 0xFF padding bytes before the (correctly
    # patched) bootloader bytes. We want a standalone bootloader file whose
    # byte 0 IS the real image - app.js supplies the offset separately when
    # flashing this file as its own manifest part - so strip that padding
    # back off afterwards.
    offset = int(args.offset, 0)
    _run_esptool([
        "--chip", args.chip,
        "merge-bin",
        "-o", args.output,
        "--flash-size", args.flash_size,
        args.offset, args.source,
    ])
    if offset:
        data = Path(args.output).read_bytes()
        Path(args.output).write_bytes(data[offset:])


def cmd_merge(args):
    argv = [
        "--chip", args.chip,
        "merge-bin",
        "-o", args.output,
        "--flash-size", args.flash_size,
    ]
    for part in args.parts:
        offset, _, file_path = part.partition(":")
        if not file_path:
            sys.exit(f"expected OFFSET:FILE, got {part!r}")
        argv += [offset, file_path]
    _run_esptool(argv)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_partitions = sub.add_parser("partitions", help="build a partition-table .bin from a CSV")
    p_partitions.add_argument("csv", help="partition-table CSV (see tools/partition_tables/)")
    p_partitions.add_argument("-o", "--output", required=True)
    p_partitions.set_defaults(func=cmd_partitions)

    p_bootloader = sub.add_parser("bootloader", help="re-flag a bootloader .bin for a different flash size")
    p_bootloader.add_argument("chip", help="e.g. esp32, esp32s2, esp32s3, esp32c3")
    p_bootloader.add_argument("source", help="reference bootloader .bin (any flash size)")
    p_bootloader.add_argument("--flash-size", required=True, help="e.g. 4MB, 8MB, 16MB, 32MB")
    p_bootloader.add_argument(
        "--offset", required=True,
        help="this chip's bootloader flash offset, e.g. 0x1000 for esp32/esp32s2, 0x0 for "
             "esp32s3/esp32c3/etc. - esptool only patches the flash-size field of the image "
             "it finds AT this chip's real bootloader offset, so getting this wrong silently "
             "produces an unpatched, unflagged output with no error (see bin/boot/README.md)"
    )
    p_bootloader.add_argument("-o", "--output", required=True)
    p_bootloader.set_defaults(func=cmd_bootloader)

    p_merge = sub.add_parser("merge", help="flatten bootloader+partitions+otadata into one boot image")
    p_merge.add_argument("chip", help="e.g. esp32, esp32c3")
    p_merge.add_argument("--flash-size", required=True, help="e.g. 4MB")
    p_merge.add_argument("-o", "--output", required=True)
    p_merge.add_argument("parts", nargs="+", help="OFFSET:FILE pairs, e.g. 0x1000:bootloader.bin")
    p_merge.set_defaults(func=cmd_merge)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
