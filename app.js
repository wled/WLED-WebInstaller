// app.js - WLED Web Installer
//
// Fetches available WLED releases from the GitHub Releases API, builds
// esp-web-tools manifests on the fly (as blob URLs) for every combination of
// version x variant x flash size, and wires up the page's controls.
//
// No build step, no server component - everything below runs directly in
// the browser so the page can be hosted as-is on GitHub Pages.

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------

  const GITHUB_RELEASES_URL = 'https://api.github.com/repos/wled/WLED/releases';
  const DOWNLOAD_MIRROR = 'https://download.wled.me';
  const CACHE_KEY = 'wled_webinstaller_releases_cache';
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const MAX_STABLE_RELEASES = 8;
  const MAX_BETA_RELEASES = 2;

  // "Basic" hides every secondary row (flash size, memory type, flash
  // mode) and forces their defaults, leaving only the release/variant
  // selection visible - see selectedFlashSize/selectedMemoryType/
  // selectedFlashMode and setManifest's forceBasicMode step below. The
  // HUB75 layout row is deliberately NOT included in that list: it stays
  // visible whenever the HUB75 variant is picked, in both modes, since
  // there's no single "default" HUB75 board to fall back to - the layout
  // choice is as essential as the version dropdown itself, not an
  // advanced/optional refinement.
  const DEFAULT_UI_MODE = 'basic';

  // Base URLs for locally-hosted bootloader / partition-table files. These
  // are chip-specific (and, for the ESP32-S3, flash-size specific) and are
  // shared across all WLED versions. bin/boot/ groups them into
  // bootloaders/<chip>/ and partitions/ subfolders - see bin/boot/README.md.
  const bootBase = new URL('bin/boot/', window.location.href).href;
  const bootloaderBase = bootBase + 'bootloaders/';
  const partitionBase = bootBase + 'partitions/';

  // ---------------------------------------------------------------------
  // Client-side bootloader flash-size patching
  // ---------------------------------------------------------------------
  // An ESP32-family bootloader image has the flash size baked into one
  // nibble of its 8-byte header, plus (on every chip used here) a SHA-256
  // digest appended over the whole image - `esptool.py write_flash` patches
  // both to match whatever `--flash_size` you pass it, but ESP Web Tools
  // (which flashes manifest parts as-is over Web Serial) does not. Rather
  // than shipping one pre-patched-and-re-signed .bin per chip x flash size
  // (see bin/boot/README.md / tools/gen_boot_images.py, which still do this
  // ahead of time via esptool for the one canonical file per chip that IS
  // committed), this re-flags a chip's single canonical reference
  // bootloader for the other declared sizes right here in the browser,
  // using Web Crypto for the SHA-256 recompute. Verified to reproduce every
  // previously pre-generated bin/boot/*.bin byte-for-byte from its chip's
  // canonical file.

  const FLASH_SIZE_NIBBLE = { '4MB': 2, '8MB': 3, '16MB': 4, '32MB': 5 };

  /**
   * Re-flag an ESP32-family bootloader image for a different flash size:
   * patch the flash-size nibble in the header, then - if the image has a
   * SHA-256 digest appended (the extended header's append-digest flag) -
   * recompute that digest over the new header. The image's checksum byte
   * (which covers only segment data, never the header) doesn't need
   * recomputing. Layout reference: 8-byte main header + 16-byte extended
   * header, then `numSegments` x (8-byte segment header + data), then
   * zero-padding to a 16-byte boundary, then the checksum byte, then
   * (optionally) the 32-byte digest.
   */
  async function patchBootloaderFlashSize(buffer, flashSizeId) {
    const nibble = FLASH_SIZE_NIBBLE[flashSizeId];
    if (nibble === undefined) throw new Error('unknown flash size: ' + flashSizeId);

    const data = new Uint8Array(buffer.slice(0));
    const view = new DataView(data.buffer);
    if (data[0] !== 0xe9) throw new Error('not an ESP image (bad magic byte)');

    const numSegments = data[1];
    const appendDigest = data[23]; // last byte of the 16-byte extended header
    let pos = 24;
    for (let i = 0; i < numSegments; i++) {
      const segLen = view.getUint32(pos + 4, true);
      pos += 8 + segLen;
    }
    const pad = (16 - ((pos + 1) % 16)) % 16;
    const hashStart = pos + pad + 1; // +1 for the checksum byte

    data[3] = (data[3] & 0x0f) | (nibble << 4);

    if (appendDigest) {
      const digest = await crypto.subtle.digest('SHA-256', data.slice(0, hashStart));
      data.set(new Uint8Array(digest), hashStart);
    }

    return data.buffer;
  }

  const bootloaderPatchCache = new Map();

  /**
   * Fetch a chip's canonical reference bootloader once (path relative to
   * bootloaderBase, e.g. "esp32-c3/bootloader_c3_8m.bin") and re-flag it for
   * `flashSizeId`, returning a blob: URL for the patched bytes (consumable
   * by ESP Web Tools exactly like a static file path). Cached per
   * (file, size) - the same pair is requested by every firmware variant of
   * every release in the dropdown, so without this every one of them would
   * re-fetch and re-hash the same bytes.
   */
  function getPatchedBootloaderUrl(fileName, flashSizeId) {
    const key = fileName + '|' + flashSizeId;
    if (!bootloaderPatchCache.has(key)) {
      bootloaderPatchCache.set(key, fetch(bootloaderBase + fileName)
        .then(function (res) { return res.arrayBuffer(); })
        .then(function (buf) { return patchBootloaderFlashSize(buf, flashSizeId); })
        .then(function (patched) {
          return URL.createObjectURL(new Blob([patched], { type: 'application/octet-stream' }));
        }));
    }
    return bootloaderPatchCache.get(key);
  }

  // ---------------------------------------------------------------------
  // Chip boot configuration
  // ---------------------------------------------------------------------
  // Describes the boot-stage parts (bootloader / partition table) that must
  // be flashed before the WLED firmware itself. The firmware part is always
  // appended last, at firmwareOffset.
  //
  // `flashSizes` is only present for chips whose bootParts can vary by flash
  // size - it drives the flash-size selector in the UI even though WLED
  // itself ships a single firmware asset for these chips (see resolveSuffix
  // / getFlashSizeAvailability, which fall back to a chip's declared
  // `flashSizes` when its VARIANTS entry is a plain string rather than a
  // per-size suffix map).

  const CHIP_CONFIG = {
    'ESP32': {
      chipFamily: 'ESP32',
      defaultFlashSize: '4MB',
      flashSizes: ['4MB', '8MB', '16MB'],
      // 8MB (bootloader_esp32_8m.bin) is the canonical reference bootloader,
      // used as-is; 4MB/16MB are that same file re-flagged client-side (see
      // getPatchedBootloaderUrl above). 4MB used to ship as a separate
      // pre-merged bootloader+partitions+otadata image instead - removed in
      // favor of re-flagging, same as every other size, now that flash-size
      // patching is known-good (see bin/boot/README.md). flashModeId picks
      // between DIO (default) and QIO bootloader files - see
      // resolveFlashMode / FLASH_MODE_BOOTLOADERS above.
      bootParts: (flashSizeId, flashModeId) => {
        const src = FLASH_MODE_BOOTLOADERS['ESP32'][resolveFlashMode('ESP32', flashModeId)];
        if (flashSizeId === '8MB') {
          return Promise.resolve([
            { path: bootloaderBase + src, offset: 4096 },
            { path: partitionBase + 'partitions_esp32_8m.bin', offset: 32768 }
          ]);
        }
        const size = flashSizeId === '16MB' ? '16MB' : '4MB';
        const partitions = size === '16MB' ? 'partitions_esp32_16m.bin' : 'partitions_c3_4m.bin';
        return getPatchedBootloaderUrl(src, size).then((url) => [
          { path: url, offset: 4096 },
          { path: partitionBase + partitions, offset: 32768 }
        ]);
      },
      firmwareOffset: 65536
    },
    'ESP32-C3': {
      chipFamily: 'ESP32-C3',
      defaultFlashSize: '4MB',
      flashSizes: ['4MB', '8MB', '16MB'],
      // Same split as ESP32 above: 8MB is the canonical reference
      // bootloader, 4MB/16MB are it re-flagged client-side. ESP32-C3 is
      // also the one chip with a real flash-mode override (see
      // FLASH_MODE_ASSETS above) - flashModeId picks between the DIO
      // (default) and QIO bootloader builds, both real PlatformIO builds
      // rather than anything patched, since flash mode is compiled-in
      // bootloader logic, not a header field (see bin/boot/README.md).
      bootParts: (flashSizeId, flashModeId) => {
        const src = FLASH_MODE_BOOTLOADERS['ESP32-C3'][resolveFlashMode('ESP32-C3', flashModeId)];
        if (flashSizeId === '8MB') {
          return Promise.resolve([
            { path: bootloaderBase + src, offset: 0 },
            { path: partitionBase + 'partitions_c3_8m.bin', offset: 32768 }
          ]);
        }
        const size = flashSizeId === '16MB' ? '16MB' : '4MB';
        const partitions = size === '16MB' ? 'partitions_c3_16m.bin' : 'partitions_c3_4m.bin';
        return getPatchedBootloaderUrl(src, size).then((url) => [
          { path: url, offset: 0 },
          { path: partitionBase + partitions, offset: 32768 }
        ]);
      },
      firmwareOffset: 65536
    },
    'ESP32-S2': {
      chipFamily: 'ESP32-S2',
      defaultFlashSize: '4MB',
      flashSizes: ['4MB', '8MB', '16MB'],
      // QIO (bootloader_s2.bin) is the canonical reference bootloader, used
      // as-is; DIO (bootloader_s2_dio.bin) is a real alternate PlatformIO
      // build - both are already flagged for 4MB natively (no re-flagging
      // needed at that size regardless of mode), 8MB/16MB re-flag whichever
      // mode was resolved. See resolveFlashMode / FLASH_MODE_BOOTLOADERS
      // above.
      bootParts: (flashSizeId, flashModeId) => {
        const src = FLASH_MODE_BOOTLOADERS['ESP32-S2'][resolveFlashMode('ESP32-S2', flashModeId)];
        if (flashSizeId === '8MB' || flashSizeId === '16MB') {
          const partitions = flashSizeId === '16MB' ? 'partitions_s2_16m.bin' : 'partitions_s2_8m.bin';
          return getPatchedBootloaderUrl(src, flashSizeId).then((url) => [
            { path: url, offset: 4096 },
            { path: partitionBase + partitions, offset: 32768 }
          ]);
        }
        return Promise.resolve([
          { path: bootloaderBase + src, offset: 4096 },
          { path: partitionBase + 'partitions_s2_4m.bin', offset: 32768 }
        ]);
      },
      firmwareOffset: 65536
    },
    'ESP32-S3': {
      chipFamily: 'ESP32-S3',
      defaultFlashSize: '8MB',
      // 8MB (bootloader_s3.bin, QIO) is the canonical reference bootloader,
      // used as-is; 4MB/16MB are that same file re-flagged client-side (see
      // getPatchedBootloaderUrl above). No normal-variant release asset
      // needs OPI mode, so resolveFlashMode never actually picks anything
      // but QIO here - the OPI bootloader (bootloader_s3_opi.bin) is real
      // and committed, but only wired into the Waveshare HUB75 layout
      // below, the one place a matching firmware asset exists for it (see
      // bin/boot/README.md's "Flash mode" section).
      bootParts: (flashSizeId, flashModeId) => {
        const src = FLASH_MODE_BOOTLOADERS['ESP32-S3'][resolveFlashMode('ESP32-S3', flashModeId)];
        if (flashSizeId === '4MB' || flashSizeId === '16MB') {
          const partitions = flashSizeId === '16MB' ? 'partitions_s3_16m.bin' : 'partitions_s3_4m.bin';
          return getPatchedBootloaderUrl(src, flashSizeId).then((url) => [
            { path: url, offset: 0 },
            { path: partitionBase + partitions, offset: 32768 }
          ]);
        }
        return Promise.resolve([
          { path: bootloaderBase + src, offset: 0 },
          { path: partitionBase + 'partitions_s3_8m.bin', offset: 32768 }
        ]);
      },
      firmwareOffset: 65536
    },
    'ESP8266': {
      chipFamily: 'ESP8266',
      defaultFlashSize: '4MB',
      bootParts: () => [],
      firmwareOffset: 0
    }
  };

  // Flash sizes shown in the UI, in display order. Not every chip supports
  // every size - see VARIANTS below.
  const FLASH_SIZES = [
    { id: '1MB', label: '1MB' },
    { id: '2MB', label: '2MB' },
    { id: '4MB', label: '4MB' },
    { id: '8MB', label: '8MB' },
    { id: '16MB', label: '16MB' }
  ];
  const DEFAULT_FLASH_SIZE = '4MB';

  // ---------------------------------------------------------------------
  // HUB75 layouts
  // ---------------------------------------------------------------------
  // Each HUB75 build targets one specific board/pinout combination rather
  // than a chip family with a flash-size choice, so it doesn't fit the
  // VARIANTS model below - a layout fully determines chip, flash size and
  // boot parts all at once. flashSizeLabel is display-only.

  const HUB75_LAYOUTS = [
    {
      id: 'esp32_default',
      label: 'ESP32 (default pinout)',
      chip: 'ESP32',
      suffix: '_ESP32_HUB75.bin',
      flashSizeLabel: '4MB',
      bootParts: () => CHIP_CONFIG['ESP32'].bootParts('4MB'),
      firmwareOffset: CHIP_CONFIG['ESP32'].firmwareOffset
    },
    {
      id: 'esp32_forum',
      label: 'ESP32 (forum pinout)',
      chip: 'ESP32',
      suffix: '_ESP32_HUB75_forum_pinout.bin',
      flashSizeLabel: '4MB',
      bootParts: () => CHIP_CONFIG['ESP32'].bootParts('4MB'),
      firmwareOffset: CHIP_CONFIG['ESP32'].firmwareOffset
    },
    {
      id: 'hdwf2',
      label: 'Huidu HD-WF2',
      chip: 'ESP32-S3',
      suffix: '_ESP32-S3_HD-WF2.bin',
      // Physically a 4MB board; WLED's own build config for it (uncommonly)
      // inherits an 8MB-declared bootloader paired with a scaled-down 4MB
      // partition table, so we match that exact pairing here rather than
      // "correct" it - it's what upstream actually ships and tests.
      flashSizeLabel: '4MB',
      bootParts: () => [
        { path: bootloaderBase + 'esp32-s3/bootloader_s3.bin', offset: 0 },
        { path: partitionBase + 'partitions_s3_hdwf2.bin', offset: 32768 }
      ],
      firmwareOffset: 65536
    },
    {
      id: 'matrixportal',
      label: 'Adafruit MatrixPortal S3',
      chip: 'ESP32-S3',
      suffix: '_ESP32-S3_Adafruit_Matrixportal.bin',
      flashSizeLabel: '8MB',
      bootParts: () => CHIP_CONFIG['ESP32-S3'].bootParts('8MB'),
      firmwareOffset: 65536
    },
    {
      id: 'moonhub',
      label: 'MOONHUB / LilyGO T7-S3',
      chip: 'ESP32-S3',
      suffix: '_ESP32-S3_16MB_opi_HUB75.bin',
      flashSizeLabel: '16MB',
      bootParts: () => CHIP_CONFIG['ESP32-S3'].bootParts('16MB'),
      firmwareOffset: 65536
    },
    {
      id: 'waveshare',
      label: 'Waveshare ESP32-S3-RGB-Matrix',
      chip: 'ESP32-S3',
      suffix: '_ESP32-S3_Waveshare_HUB75.bin',
      // This board uses opi_opi memory (octal flash + octal PSRAM sharing
      // the same MSPI controller), which - unlike every other S3 board here -
      // genuinely changes the bootloader's compiled boot logic (real octal
      // "OPI" boot, not just a different PSRAM bus width the bootloader
      // doesn't care about). bootloader_s3_opi.bin is a real PlatformIO
      // build targeting that exact config; re-flagging it to 32MB
      // client-side works the same way as every other chip/size combo (see
      // bin/boot/README.md's "Flash mode" section) - no separate 32MB-only
      // file needed anymore.
      flashSizeLabel: '32MB',
      bootParts: () => getPatchedBootloaderUrl('esp32-s3/bootloader_s3_opi.bin', '32MB').then((url) => [
        { path: url, offset: 0 },
        { path: partitionBase + 'partitions_s3_32m.bin', offset: 32768 }
      ]),
      firmwareOffset: 65536
    }
  ];
  const DEFAULT_HUB75_LAYOUT = HUB75_LAYOUTS[0].id;

  // ---------------------------------------------------------------------
  // Variant definitions
  // ---------------------------------------------------------------------
  // Each variant maps chip families to the asset-name suffix used in GitHub
  // release assets. A chip entry is either:
  //   - a plain string:              one asset, flash size is irrelevant
  //   - a { flashSizeId: suffix }    map: the chip ships multiple binaries
  //                                   for different flash sizes
  //
  // Chips that have no entry for a given variant are simply left out of the
  // generated manifest for that variant (e.g. "audio" is ESP32-only).

  const VARIANTS = {
    normal: {
      'ESP32':    '_ESP32.bin',
      'ESP32-C3': '_ESP32-C3.bin',
      'ESP32-S2': '_ESP32-S2.bin',
      // 8MB defaults to the no-PSRAM build, same "assume nothing extra
      // unless told otherwise" default as ESP32/Wrover below - OPI PSRAM is
      // an opt-in via the memory-type row, not the default, even though
      // most 8MB S3 dev boards do have it.
      'ESP32-S3': { '4MB': '_ESP32-S3_4M_qspi.bin', '8MB': '_ESP32-S3_8MB_none.bin', '16MB': '_ESP32-S3_16MB_opi.bin' },
      'ESP8266':  { '1MB': '_ESP01.bin', '2MB': '_ESP02.bin', '4MB': '_ESP8266.bin' }
    },
    ethernet: {
      'ESP32': '_ESP32_Ethernet.bin'
    },
    audio: {
      'ESP32': '_ESP32_audioreactive.bin'
    },
    test: {
      'ESP8266': { '1MB': '_ESP01_160.bin', '2MB': '_ESP02_160.bin', '4MB': '_ESP8266_160.bin' }
    },
    v4: {
      'ESP32': '_ESP32_V4.bin'
    },
    debug: {
      'ESP32': '_ESP32_DEBUG.bin'
    }
  };

  // Maps variant names to the DOM ids used for their radio inputs. "hub75"
  // is handled outside the VARIANTS table (see HUB75_LAYOUTS above) but its
  // radio button follows the same enable/disable convention as the rest.
  const VARIANT_IDS = ['normal', 'ethernet', 'audio', 'test', 'v4', 'debug', 'hub75'];

  // ---------------------------------------------------------------------
  // Memory (PSRAM) variants
  // ---------------------------------------------------------------------
  // A handful of chips ship an alternate firmware build for a different
  // PSRAM configuration - WLED only publishes these for the "normal"
  // variant. This is a separate axis from flash size and deliberately
  // doesn't reuse the VARIANTS table: the bootloader/partition table don't
  // care about PSRAM at all (PSRAM init happens app-side, not in the 2nd
  // stage bootloader - see bin/boot/README.md), so a memory variant is
  // purely a different firmware asset paired with the SAME boot files the
  // base chip already uses at that flash size. Overriding just the suffix
  // here (rather than adding these as extra VARIANTS/CHIP_CONFIG chips)
  // also keeps them out of the flash-size chart, where they'd otherwise
  // show up as confusing near-duplicates of ESP32/ESP32-S3.
  //
  // `suffixes` is either one suffix (applies at every flash size a chip
  // actually declares - see CHIP_CONFIG[chip].flashSizes) or a
  // { flashSizeId: suffix } map for sizes where the alternate build only
  // exists at one specific size (the PSRAM bus mode split for ESP32-S3 is
  // only published at 8MB - 4MB is already QSPI-only and 16MB is already
  // OPI-only regardless of this selection). "standard" itself means no
  // PSRAM for every chip, including ESP32-S3 at 8MB - OPI is an opt-in
  // override here just like Wrover/QSPI, even though it's common on 8MB
  // dev boards. Wrover uses the map form even though WLED only ever
  // publishes one `_ESP32_WROVER.bin` asset (repeated across its three
  // real sizes) specifically so it's absent - and the option hidden - at
  // 1MB/2MB, sizes ESP32 (Wrover or otherwise) never actually comes in;
  // those only exist for ESP8266 in the flash-size row (see FLASH_SIZES).
  const MEMORY_TYPE_IDS = ['standard', 'wrover', 'qspi', 'opi'];
  const DEFAULT_MEMORY_TYPE = 'standard';

  const MEMORY_TYPE_ASSETS = {
    wrover: { chip: 'ESP32', suffixes: { '4MB': '_ESP32_WROVER.bin', '8MB': '_ESP32_WROVER.bin', '16MB': '_ESP32_WROVER.bin' } },
    qspi: { chip: 'ESP32-S3', suffixes: { '8MB': '_ESP32-S3_8MB_qspi.bin' } },
    opi: { chip: 'ESP32-S3', suffixes: { '8MB': '_ESP32-S3_8MB_opi.bin' } }
  };

  /** Resolve a memory-variant override suffix for this chip/size, or null if none applies. */
  function resolveMemoryOverrideSuffix(memTypeId, chip, flashSizeId) {
    const entry = MEMORY_TYPE_ASSETS[memTypeId];
    if (!entry || entry.chip !== chip) return null;
    if (typeof entry.suffixes === 'string') return entry.suffixes;
    return entry.suffixes[flashSizeId] || null;
  }

  // ---------------------------------------------------------------------
  // Flash-mode overrides
  // ---------------------------------------------------------------------
  // Unlike flash size (a header nibble this repo can patch - see
  // getPatchedBootloaderUrl above), flash mode is baked into the
  // bootloader's *compiled* SPI-flash-init logic, so every mode needs its
  // own real PlatformIO build - there's nothing to compute client-side
  // here, just a different committed bootloader file to pick. Every chip
  // has its own native default mode (whatever its normal WLED release
  // asset is actually built with); ESP32-C3 additionally has a real
  // *override* - a genuinely separate release asset WLED publishes for a
  // different mode. See bin/boot/README.md's "Flash mode" section for the
  // full picture, including modes that exist as committed bootloader
  // files but have no matching WLED firmware (ESP32-S3's OPI file is one -
  // it's wired directly into the Waveshare HUB75 layout instead of this
  // general axis, since that's the only place a matching firmware asset
  // exists for it).

  const FLASH_MODES = [
    { id: 'dio', label: 'DIO' },
    { id: 'qio', label: 'QIO' }
  ];
  const FLASH_MODE_IDS = ['default', 'dio', 'qio'];
  const DEFAULT_FLASH_MODE = 'default';

  // Each chip's own native mode - what "Default" resolves to, and what a
  // chip falls back to when the globally selected mode isn't one WLED
  // actually publishes a matching firmware asset for (see resolveFlashMode
  // below). ESP8266 has no entry - it has no flash-mode axis at all.
  const CHIP_DEFAULT_FLASH_MODE = {
    'ESP32': 'dio',
    'ESP32-C3': 'dio',
    'ESP32-S2': 'qio',
    'ESP32-S3': 'qio'
  };

  // Bootloader files per chip x mode (see bin/boot/README.md's "Flash
  // mode" section for how each was built and verified). Includes modes
  // with no matching WLED firmware asset, committed for completeness -
  // resolveFlashMode() below is what actually gates which ones this app
  // will ever request, so an unpaired file here is inert, not a risk.
  const FLASH_MODE_BOOTLOADERS = {
    'ESP32':    { dio: 'esp32/bootloader_esp32_8m.bin', qio: 'esp32/bootloader_esp32_8m_qio.bin' },
    'ESP32-C3': { dio: 'esp32-c3/bootloader_c3_8m.bin', qio: 'esp32-c3/bootloader_c3_8m_qio.bin' },
    'ESP32-S2': { qio: 'esp32-s2/bootloader_s2.bin', dio: 'esp32-s2/bootloader_s2_dio.bin' },
    'ESP32-S3': { qio: 'esp32-s3/bootloader_s3.bin', opi: 'esp32-s3/bootloader_s3_opi.bin' }
  };

  // Real firmware-asset overrides - ONLY (chip, mode) pairs WLED actually
  // publishes as a separate release binary for. Everything else falls
  // back to the chip's own default mode, for both the firmware suffix and
  // the bootloader file (resolveFlashMode is the single source of truth
  // for both, so the two can never end up mismatched).
  const FLASH_MODE_ASSETS = {
    qio: { chip: 'ESP32-C3', suffix: '_ESP32-C3-QIO.bin' }
  };

  /**
   * Resolve the effective flash mode for a chip given the globally
   * selected mode: the selection itself if it's this chip's own native
   * mode, or a real WLED-published override for it - otherwise this
   * chip's own default. Returns null for chips with no flash-mode axis
   * (ESP8266). Used for BOTH the firmware suffix and the bootloader file
   * (see generateManifest / CHIP_CONFIG[*].bootParts), so a mismatch
   * between the two - the exact bug this axis exists to avoid - is
   * structurally impossible.
   */
  function resolveFlashMode(chip, flashModeId) {
    const defaultMode = CHIP_DEFAULT_FLASH_MODE[chip];
    if (!defaultMode) return null;
    if (flashModeId === defaultMode) return defaultMode;
    const entry = FLASH_MODE_ASSETS[flashModeId];
    if (entry && entry.chip === chip) return flashModeId;
    return defaultMode;
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** Return true when a chip entry has a flash-size selection axis. */
  function hasFlashAxis(entry) {
    return entry !== null && typeof entry === 'object';
  }

  /** Resolve the asset suffix for a chip, given the globally selected flash size. */
  function resolveSuffix(entry, chip, flashSizeId) {
    if (!hasFlashAxis(entry)) return entry;
    return entry[flashSizeId] || entry[CHIP_CONFIG[chip].defaultFlashSize];
  }

  /** Find a release asset whose name ends with `suffix` (ignore .gz files). */
  function findAsset(assets, suffix) {
    if (!suffix) return null;
    return assets.find(function (a) {
      return a.name.endsWith(suffix) && !a.name.endsWith('.gz');
    }) || null;
  }

  /** Rewrite a GitHub release asset URL to WLED's CORS-enabled download mirror. */
  function mirrorUrl(githubUrl) {
    return DOWNLOAD_MIRROR + new URL(githubUrl).pathname;
  }

  /** Extract the WLED version string from asset filenames (for nightly). */
  function extractVersionFromAssets(assets) {
    for (let i = 0; i < assets.length; i++) {
      const m = assets[i].name.match(/^WLED_(.+?)_(ESP\d|ESP8)/);
      if (m) return m[1];
    }
    return 'unknown';
  }

  /** Build the human-friendly release label shown in the version dropdown. */
  function getDisplayVersion(release) {
    if (release.tag_name === 'nightly') {
      return extractVersionFromAssets(release.assets) + ' Nightly';
    }
    return release.tag_name.replace(/^v/, '');
  }

  /** Build the version string stored in generated manifests. */
  function getManifestVersion(release, variantName) {
    let ver = release.tag_name === 'nightly'
      ? extractVersionFromAssets(release.assets)
      : release.tag_name.replace(/^v/, '');
    if (variantName !== 'normal') ver += ' ' + variantName;
    return ver;
  }

  /** Classify a release into release/beta/nightly buckets. */
  function categorize(release) {
    if (release.tag_name === 'nightly') return 'nightly';
    if (release.prerelease) return 'beta';
    return 'release';
  }

  // ---------------------------------------------------------------------
  // Manifest generation
  // ---------------------------------------------------------------------

  /**
   * Build an esp-web-tools manifest object for the given release + variant +
   * flash size + memory (PSRAM) type + flash mode. Returns null if no
   * matching assets are found at all. `memTypeId` only ever applies to the
   * "normal" variant - other variants don't publish memory-variant builds,
   * so it's simply ignored for them (resolveMemoryOverrideSuffix would
   * never match anyway, but the check avoids relying on that implicitly).
   * `flashModeId` is resolved per-chip via resolveFlashMode() regardless of
   * variant - outside "normal" it's forced to each chip's own default mode,
   * since no other variant publishes a flash-mode override.
   */
  async function generateManifest(release, variantName, flashSizeId, memTypeId, flashModeId) {
    const chipEntries = VARIANTS[variantName];
    const version = getManifestVersion(release, variantName);
    const builds = [];

    for (const chip in chipEntries) {
      const overrideSuffix = variantName === 'normal' && memTypeId
        ? resolveMemoryOverrideSuffix(memTypeId, chip, flashSizeId)
        : null;
      const flashMode = variantName === 'normal' ? resolveFlashMode(chip, flashModeId) : CHIP_DEFAULT_FLASH_MODE[chip];
      const flashModeSuffix = flashMode && flashMode !== CHIP_DEFAULT_FLASH_MODE[chip]
        ? FLASH_MODE_ASSETS[flashMode].suffix
        : null;
      const suffix = overrideSuffix || flashModeSuffix || resolveSuffix(chipEntries[chip], chip, flashSizeId);
      const asset = findAsset(release.assets, suffix);
      if (!asset) continue;

      const config = CHIP_CONFIG[chip];
      const parts = await config.bootParts(flashSizeId, flashMode);
      parts.push({
        path: mirrorUrl(asset.browser_download_url),
        offset: config.firmwareOffset
      });

      builds.push({ chipFamily: config.chipFamily, parts: parts });
    }

    if (builds.length === 0) return null;

    return {
      name: 'WLED',
      version: version,
      home_assistant_domain: 'wled',
      new_install_prompt_erase: true,
      builds: builds
    };
  }

  /**
   * Build a manifest for a single HUB75 layout (one specific board). Unlike
   * generateManifest(), this always produces at most one build entry, since
   * a layout already fully determines the chip.
   */
  async function generateHub75Manifest(release, layoutId) {
    const layout = HUB75_LAYOUTS.find(function (l) { return l.id === layoutId; });
    if (!layout) return null;

    const asset = findAsset(release.assets, layout.suffix);
    if (!asset) return null;

    const parts = await layout.bootParts();
    parts.push({
      path: mirrorUrl(asset.browser_download_url),
      offset: layout.firmwareOffset
    });

    return {
      name: 'WLED',
      version: getManifestVersion(release, 'hub75'),
      home_assistant_domain: 'wled',
      new_install_prompt_erase: true,
      builds: [{ chipFamily: layout.chip, parts: parts }]
    };
  }

  /** Convert a manifest object into a blob URL consumable by esp-web-tools. */
  function createManifestUrl(manifest) {
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    return URL.createObjectURL(blob);
  }

  /**
   * For a given release + variant, figure out which chips are actually
   * available at each flash size (i.e. a matching release asset exists).
   * A chip's VARIANTS entry is either a per-size suffix map (the chip ships
   * multiple firmware binaries, e.g. ESP32-S3) or a single fixed suffix (one
   * binary covers every flash size, e.g. ESP32) - in the latter case the
   * available sizes come from CHIP_CONFIG[chip].flashSizes instead, since
   * the same firmware asset is paired with different boot files depending
   * on the chosen size. The row itself is only shown when at least one chip
   * in this variant has a real choice to make.
   */
  function getFlashSizeAvailability(release, variantName) {
    const chipEntries = VARIANTS[variantName];

    function fixedSizes(chip) {
      return (CHIP_CONFIG[chip] && CHIP_CONFIG[chip].flashSizes) || [];
    }

    const axisChips = Object.keys(chipEntries).filter(function (chip) {
      return hasFlashAxis(chipEntries[chip]) || fixedSizes(chip).length > 1;
    });

    const chipsBySize = {};
    FLASH_SIZES.forEach(function (fs) { chipsBySize[fs.id] = []; });

    Object.keys(chipEntries).forEach(function (chip) {
      const entry = chipEntries[chip];
      if (hasFlashAxis(entry)) {
        Object.keys(entry).forEach(function (sizeId) {
          if (findAsset(release.assets, entry[sizeId])) chipsBySize[sizeId].push(chip);
        });
      } else if (findAsset(release.assets, entry)) {
        fixedSizes(chip).forEach(function (sizeId) { chipsBySize[sizeId].push(chip); });
      }
    });

    return { hasAxis: axisChips.length > 0, chipsBySize: chipsBySize };
  }

  /**
   * Given a release + the currently selected flash size, figure out which
   * memory (PSRAM) types have a real asset to offer. Only the "normal"
   * variant ever has these, so callers should only invoke this there.
   * "standard" (no override - today's default behavior for every chip) is
   * always considered available; the row itself is only shown when at
   * least one non-standard option also resolves to a real asset.
   */
  function getMemoryTypeAvailability(release, flashSizeId) {
    const availability = { standard: true };
    Object.keys(MEMORY_TYPE_ASSETS).forEach(function (memId) {
      const entry = MEMORY_TYPE_ASSETS[memId];
      const suffix = resolveMemoryOverrideSuffix(memId, entry.chip, flashSizeId);
      availability[memId] = !!findAsset(release.assets, suffix);
    });
    const hasAxis = Object.keys(MEMORY_TYPE_ASSETS).some(function (memId) { return availability[memId]; });
    return { hasAxis: hasAxis, availability: availability };
  }

  /**
   * For a given release + variant + the currently selected flash size,
   * figure out which chips are actually available at each flash mode -
   * mirrors getFlashSizeAvailability's shape/pattern exactly (same idea:
   * a mode "applies to" a chip either because it's that chip's own native
   * mode with a real matching asset, or because WLED publishes a genuine
   * override for it - see FLASH_MODE_ASSETS). Depends on flashSizeId
   * because a chip's own suffix can vary by size (e.g. ESP32-S3's
   * per-size map), same reason getMemoryTypeAvailability takes it. The row
   * itself is only shown when at least one chip has a real override to
   * offer - a chip with only its own single native mode isn't "an axis".
   */
  function getFlashModeAvailability(release, variantName, flashSizeId) {
    const chipEntries = VARIANTS[variantName];

    const chipsByMode = {};
    FLASH_MODES.forEach(function (m) { chipsByMode[m.id] = []; });

    Object.keys(chipEntries).forEach(function (chip) {
      const defaultMode = CHIP_DEFAULT_FLASH_MODE[chip];
      if (!defaultMode || !chipsByMode[defaultMode]) return;
      const baseSuffix = resolveSuffix(chipEntries[chip], chip, flashSizeId);
      if (findAsset(release.assets, baseSuffix)) chipsByMode[defaultMode].push(chip);
    });

    Object.keys(FLASH_MODE_ASSETS).forEach(function (modeId) {
      if (!chipsByMode[modeId]) return;
      const entry = FLASH_MODE_ASSETS[modeId];
      if (!chipEntries[entry.chip]) return;
      if (findAsset(release.assets, entry.suffix) && chipsByMode[modeId].indexOf(entry.chip) === -1) {
        chipsByMode[modeId].push(entry.chip);
      }
    });

    const hasAxis = Object.keys(FLASH_MODE_ASSETS).some(function (modeId) {
      return !!chipEntries[FLASH_MODE_ASSETS[modeId].chip];
    });
    return { hasAxis: hasAxis, chipsByMode: chipsByMode };
  }

  // ---------------------------------------------------------------------
  // Dropdown population
  // ---------------------------------------------------------------------

  /**
   * Create a single <option> element for a release. All variant x flash-size
   * x memory-type x flash-mode manifests are pre-generated as blob URLs and
   * stashed on the option so the UI code can look them up synchronously.
   * The memory-type/flash-mode fan-out only happens for "normal" (the only
   * variant with these alternate builds) - every other variant just
   * generates one manifest per flash size, stored under the
   * "standard|default" key, same as before these axes existed. Memory type
   * and flash mode are independent per-chip overrides within the same
   * manifest (see generateManifest), so every combination of the two needs
   * its own manifest - stored under a composite "memTypeId|flashModeId" key
   * rather than a third nesting level.
   */
  async function createOption(release) {
    const opt = document.createElement('option');
    opt.textContent = getDisplayVersion(release);

    const manifests = {}; // variant -> flashSizeId -> "memTypeId|flashModeId" -> manifest URL
    const availability = {}; // variant -> { hasAxis, availability }
    let hasPlain = false;

    for (const variantName in VARIANTS) {
      const bySize = {};
      for (const fs of FLASH_SIZES) {
        const byKey = {};
        const memTypeIds = variantName === 'normal' ? MEMORY_TYPE_IDS : [DEFAULT_MEMORY_TYPE];
        const flashModeIds = variantName === 'normal' ? FLASH_MODE_IDS : [DEFAULT_FLASH_MODE];
        for (const memId of memTypeIds) {
          for (const modeId of flashModeIds) {
            const manifest = await generateManifest(release, variantName, fs.id, memId, modeId);
            if (manifest) byKey[memId + '|' + modeId] = createManifestUrl(manifest);
          }
        }
        if (Object.keys(byKey).length > 0) bySize[fs.id] = byKey;
      }
      availability[variantName] = getFlashSizeAvailability(release, variantName);
      if (Object.keys(bySize).length > 0) {
        manifests[variantName] = bySize;
        if (variantName === 'normal') hasPlain = true;
      }
    }

    manifests.hub75 = {};
    const hub75Availability = {};
    for (const layout of HUB75_LAYOUTS) {
      const manifest = await generateHub75Manifest(release, layout.id);
      hub75Availability[layout.id] = !!manifest;
      if (manifest) manifests.hub75[layout.id] = createManifestUrl(manifest);
    }
    if (Object.keys(manifests.hub75).length === 0) delete manifests.hub75;

    if (!hasPlain) return null;

    opt._manifests = manifests;
    opt._flashAvailability = availability;
    opt._hub75Availability = hub75Availability;
    opt._release = release;
    return opt;
  }

  /**
   * Populate the release dropdown with grouped options and generated
   * manifests. Async because building each option's manifests now involves
   * client-side bootloader patching (fetch + SHA-256 recompute) for some
   * chip/flash-size combinations - see getPatchedBootloaderUrl above.
   */
  async function populateDropdown(releases) {
    const sel = document.getElementById('ver');

    const groups = { release: [], beta: [], nightly: [] };
    releases.forEach(function (r) {
      if (r.draft || !r.assets || r.assets.length === 0) return;
      groups[categorize(r)].push(r);
    });

    if (groups.release.length > MAX_STABLE_RELEASES) {
      groups.release = groups.release.slice(0, MAX_STABLE_RELEASES);
    }
    if (groups.beta.length > MAX_BETA_RELEASES) {
      groups.beta = groups.beta.slice(0, MAX_BETA_RELEASES);
    }

    const fragment = document.createDocumentFragment();
    const labels = { release: 'Release', beta: 'Beta', nightly: 'Nightly' };

    for (const key of ['release', 'beta', 'nightly']) {
      if (groups[key].length === 0) continue;
      const opts = await Promise.all(groups[key].map(createOption));
      const grp = document.createElement('optgroup');
      grp.label = labels[key];
      opts.forEach(function (opt) {
        if (opt) grp.appendChild(opt);
      });
      if (grp.children.length > 0) fragment.appendChild(grp);
    }

    if (fragment.children.length === 0) {
      showLoadError();
      return;
    }

    sel.innerHTML = '';
    sel.appendChild(fragment);
  }

  // ---------------------------------------------------------------------
  // Caching (sessionStorage, 5-minute TTL)
  // ---------------------------------------------------------------------

  /** Read cached GitHub release metadata if it is still within TTL. */
  function getCachedReleases() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.timestamp < CACHE_TTL) return data.releases;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Persist GitHub release metadata in sessionStorage with a timestamp. */
  function cacheReleases(releases) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), releases: releases }));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------

  /** Get the currently selected release <option> element. */
  function currentOption() {
    const sel = document.getElementById('ver');
    return sel.options[sel.selectedIndex];
  }

  /** Get the selected UI mode ("basic" or "advanced") from its radio group. */
  function selectedUiMode() {
    const checked = document.querySelector('input[name="uimode"]:checked');
    return checked ? checked.value : DEFAULT_UI_MODE;
  }

  /** Get the selected firmware variant id from the variant radio group. */
  function selectedVariant() {
    const checked = document.querySelector('input[name="version"]:checked');
    return checked ? checked.value : 'normal';
  }

  /**
   * Get the selected flash-size id from the flash-size radio group. In
   * Basic mode the row is hidden and this always returns the default
   * (4MB) regardless of the hidden radio's actual state - every declared
   * flash size is reachable via client-side re-flagging (see
   * getPatchedBootloaderUrl), so 4MB is always a valid choice for every
   * chip/variant.
   */
  function selectedFlashSize() {
    if (selectedUiMode() === 'basic') return DEFAULT_FLASH_SIZE;
    const checked = document.querySelector('input[name="flashsize"]:checked');
    return checked ? checked.value : DEFAULT_FLASH_SIZE;
  }

  /** Get the selected memory (PSRAM) type id from its radio group. Forced to "standard" in Basic mode - see selectedFlashSize. */
  function selectedMemoryType() {
    if (selectedUiMode() === 'basic') return DEFAULT_MEMORY_TYPE;
    const checked = document.querySelector('input[name="memorytype"]:checked');
    return checked ? checked.value : DEFAULT_MEMORY_TYPE;
  }

  /** Get the selected flash-mode id from its radio group. Forced to "default" in Basic mode - see selectedFlashSize. */
  function selectedFlashMode() {
    if (selectedUiMode() === 'basic') return DEFAULT_FLASH_MODE;
    const checked = document.querySelector('input[name="flashmode"]:checked');
    return checked ? checked.value : DEFAULT_FLASH_MODE;
  }

  /** Get the selected HUB75 layout id from the layout radio group. */
  function selectedLayout() {
    const checked = document.querySelector('input[name="layout"]:checked');
    return checked ? checked.value : DEFAULT_HUB75_LAYOUT;
  }

  /** Enable/disable + show/hide the variant radio buttons for the current release. */
  function updateVariantAvailability(opt) {
    VARIANT_IDS.forEach(function (id) {
      const input = document.getElementById(id);
      const label = document.getElementById(id + '_label');
      const available = !!(opt._manifests && opt._manifests[id]);
      input.disabled = !available;
      label.classList.toggle('disabled__label', !available);
      label.classList.toggle('radio__label', available);
    });
  }

  /**
   * Enable/disable + show/hide the flash-size radio buttons, and hide the
   * whole row if irrelevant. The buttons themselves only ever show the
   * size (e.g. "8MB") - which chips that size applies to is rendered in
   * the small chart below instead, so the buttons stay a fixed, compact
   * width regardless of how many chips share a size.
   */
  function updateFlashSizeAvailability(opt, variantName) {
    const row = document.getElementById('flashSizeRow');
    const info = opt._flashAvailability ? opt._flashAvailability[variantName] : null;

    if (!info || !info.hasAxis) {
      row.hidden = true;
      return;
    }
    row.hidden = false;

    FLASH_SIZES.forEach(function (fs) {
      const input = document.getElementById('fs_' + fs.id);
      const label = document.getElementById('fs_' + fs.id + '_label');
      const chartRow = document.getElementById('fsChart_' + fs.id);
      const chartChips = document.getElementById('fsChart_' + fs.id + '_chips');
      const chips = info.chipsBySize[fs.id];
      const available = chips.length > 0;
      input.disabled = !available;
      label.classList.toggle('disabled__label', !available);
      label.classList.toggle('radio__label', available);
      label.textContent = fs.label;
      chartRow.hidden = !available;
      chartChips.textContent = chips.join(', ');
    });

    // If the currently checked size is no longer available, fall back to the
    // default, or to whichever size is available if even that is missing.
    const checkedInput = document.getElementById('fs_' + selectedFlashSize());
    if (checkedInput.disabled) {
      const fallback = document.getElementById('fs_' + DEFAULT_FLASH_SIZE);
      const target = fallback.disabled ? document.querySelector('#flashSizeRow input:not(:disabled)') : fallback;
      if (target) target.checked = true;
    }
  }

  /**
   * Enable/disable + show/hide the memory-type (PSRAM) radio buttons, and
   * hide the whole row if irrelevant. Only the "normal" variant ever has
   * memory variants, and which ones apply depends on the currently
   * selected flash size (the S3 PSRAM-mode choice only exists at 8MB), so
   * this needs to be recomputed on both variant and flash-size changes.
   */
  function updateMemoryTypeAvailability(opt, variantName, flashSizeId) {
    const row = document.getElementById('memoryTypeRow');

    if (variantName !== 'normal' || !opt._release) {
      row.hidden = true;
      return;
    }
    const info = getMemoryTypeAvailability(opt._release, flashSizeId);
    if (!info.hasAxis) {
      row.hidden = true;
      return;
    }
    row.hidden = false;

    MEMORY_TYPE_IDS.forEach(function (memId) {
      const input = document.getElementById('mt_' + memId);
      const label = document.getElementById('mt_' + memId + '_label');
      const available = info.availability[memId];
      input.disabled = !available;
      label.classList.toggle('disabled__label', !available);
      label.classList.toggle('radio__label', available);
    });

    const checkedInput = document.getElementById('mt_' + selectedMemoryType());
    if (checkedInput.disabled) {
      document.getElementById('mt_' + DEFAULT_MEMORY_TYPE).checked = true;
    }
  }

  /**
   * Enable/disable + show/hide the flash-mode radio buttons (and their
   * chart), and hide the whole row if irrelevant. Only the "normal"
   * variant ever has flash-mode overrides, and - like memory type - a
   * chip's own suffix can vary by flash size, so this needs recomputing on
   * both variant and flash-size changes. "Default" is never disabled here
   * (it always resolves validly per chip - see resolveFlashMode); only the
   * concrete DIO/QIO buttons and chart rows reflect real availability,
   * same treatment as the flash-size buttons/chart.
   */
  function updateFlashModeAvailability(opt, variantName, flashSizeId) {
    const row = document.getElementById('flashModeRow');

    if (variantName !== 'normal' || !opt._release) {
      row.hidden = true;
      return;
    }
    const info = getFlashModeAvailability(opt._release, variantName, flashSizeId);
    if (!info.hasAxis) {
      row.hidden = true;
      return;
    }
    row.hidden = false;

    FLASH_MODES.forEach(function (mode) {
      const input = document.getElementById('fm_' + mode.id);
      const label = document.getElementById('fm_' + mode.id + '_label');
      const chartRow = document.getElementById('fmChart_' + mode.id);
      const chartChips = document.getElementById('fmChart_' + mode.id + '_chips');
      const chips = info.chipsByMode[mode.id];
      const available = chips.length > 0;
      input.disabled = !available;
      label.classList.toggle('disabled__label', !available);
      label.classList.toggle('radio__label', available);
      chartRow.hidden = !available;
      chartChips.textContent = chips.join(', ');
    });

    const checkedInput = document.getElementById('fm_' + selectedFlashMode());
    if (checkedInput.disabled) {
      document.getElementById('fm_' + DEFAULT_FLASH_MODE).checked = true;
    }
  }

  /**
   * Enable/disable the HUB75 layout radio buttons and hide/show the whole
   * row if irrelevant. Buttons only show the board name - the chip + flash
   * size each one needs is rendered in the chart below instead, same
   * treatment as the flash-size buttons above.
   */
  function updateLayoutAvailability(opt) {
    const info = opt._hub75Availability || {};

    HUB75_LAYOUTS.forEach(function (layout) {
      const input = document.getElementById('layout_' + layout.id);
      const label = document.getElementById('layout_' + layout.id + '_label');
      const chartRow = document.getElementById('layoutChart_' + layout.id);
      const available = !!info[layout.id];
      input.disabled = !available;
      label.classList.toggle('disabled__label', !available);
      label.classList.toggle('radio__label', available);
      label.textContent = layout.label;
      chartRow.hidden = !available;
    });

    const checkedInput = document.getElementById('layout_' + selectedLayout());
    if (checkedInput.disabled) {
      const fallback = document.querySelector('#layoutRow input:not(:disabled)');
      if (fallback) fallback.checked = true;
    }
  }

  /**
   * In Basic mode, hide flashSizeRow/memoryTypeRow/flashModeRow no matter
   * what their own availability checks just decided - called last, after
   * updateSecondaryRow/updateMemoryTypeAvailability/updateFlashModeAvailability,
   * so it always wins. layoutRow is untouched: see the DEFAULT_UI_MODE
   * comment for why HUB75's layout choice isn't treated as "advanced".
   * The rows' underlying radio selections are left alone (not reset) -
   * selectedFlashSize/selectedMemoryType/selectedFlashMode already force
   * the effective values to their defaults while in Basic mode, so a
   * user's Advanced-mode picks simply reappear if they switch back.
   */
  function forceBasicMode() {
    if (selectedUiMode() !== 'basic') return;
    document.getElementById('flashSizeRow').hidden = true;
    document.getElementById('memoryTypeRow').hidden = true;
    document.getElementById('flashModeRow').hidden = true;
  }

  /** Show/update whichever secondary row (flash size, or HUB75 layout) applies to the current variant. */
  function updateSecondaryRow(opt, variantName) {
    const flashRow = document.getElementById('flashSizeRow');
    const layoutRow = document.getElementById('layoutRow');

    if (variantName === 'hub75') {
      flashRow.hidden = true;
      updateLayoutAvailability(opt);
      layoutRow.hidden = false;
    } else {
      layoutRow.hidden = true;
      updateFlashSizeAvailability(opt, variantName);
    }
  }

  /** Apply current release/variant/size selections and set install manifest URL. */
  function setManifest() {
    const opt = currentOption();
    if (!opt || !opt._manifests) return;

    updateVariantAvailability(opt);
    let variantName = selectedVariant();
    if (!opt._manifests[variantName]) {
      resetVariant();
      variantName = 'normal';
    }
    updateSecondaryRow(opt, variantName);

    let manifestUrl;
    if (variantName === 'hub75') {
      document.getElementById('memoryTypeRow').hidden = true;
      document.getElementById('flashModeRow').hidden = true;

      const layoutId = selectedLayout();
      manifestUrl = opt._manifests.hub75[layoutId]
        || opt._manifests.hub75[Object.keys(opt._manifests.hub75)[0]];
    } else {
      // Read flash size fresh - updateSecondaryRow (via updateFlashSizeAvailability)
      // may have just corrected the checked button to a still-available one.
      const flashSizeId = selectedFlashSize();
      updateMemoryTypeAvailability(opt, variantName, flashSizeId);
      updateFlashModeAvailability(opt, variantName, flashSizeId);

      const byKey = opt._manifests[variantName][flashSizeId]
        || opt._manifests[variantName][Object.keys(opt._manifests[variantName])[0]];
      // Same idea: read memory type / flash mode after their own update*Availability corrections above.
      const key = selectedMemoryType() + '|' + selectedFlashMode();
      manifestUrl = byKey[key] || byKey[Object.keys(byKey)[0]];
    }

    forceBasicMode();

    document.getElementById('inst').setAttribute('manifest', manifestUrl);
    document.getElementById('verstr').textContent = opt.text;
  }

  /** Reset variant selection to the default "normal" option. */
  function resetVariant() {
    document.getElementById('normal').checked = true;
  }

  /** Switch to the unsupported-browser panel when install is unavailable. */
  function checkSupported() {
    if (document.getElementById('inst').hasAttribute('install-unsupported')) unsupported();
  }

  /** Show unsupported-browser message and hide flasher UI. */
  function unsupported() {
    document.getElementById('flasher').hidden = true;
    document.getElementById('unsupported').hidden = false;
  }

  /** Reveal troubleshooting instructions for serial/WebSerial issues. */
  function showSerialHelp() {
    document.getElementById('showSerialHelp').hidden = true;
    document.getElementById('serialHelp').hidden = false;
  }

  /** Show a release-loading failure panel. */
  function showLoadError() {
    document.getElementById('flasher').hidden = true;
    document.getElementById('loadError').hidden = false;
  }

  /** Show a download-blocked panel when firmware bytes cannot be fetched. */
  function showProxyBlocked() {
    document.getElementById('flasher').hidden = true;
    document.getElementById('proxyBlocked').hidden = false;
  }

  /** Recompute selected manifest after release changes. */
  function applySelection() {
    resetVariant();
    setManifest();
  }

  // ---------------------------------------------------------------------
  // Download mirror health check
  // ---------------------------------------------------------------------
  // GitHub release assets have no CORS headers, so every firmware download
  // goes through download.wled.me, WLED's official CORS-enabled mirror.
  // Something on the network (an ad-blocker, firewall, or DNS block) could
  // still be preventing that connection, which esp-web-tools would otherwise
  // happily try to flash as garbage. Check once per page load, on a real
  // asset URL, and refuse to enable Install until we know real firmware
  // bytes come back.

  let proxyHealthChecked = false;

  /** Pick a real firmware asset URL for verifying the download mirror. */
  function getHealthCheckUrl(release) {
    const chipEntries = VARIANTS.normal;
    for (const chip in chipEntries) {
      const suffix = resolveSuffix(chipEntries[chip], chip, DEFAULT_FLASH_SIZE);
      const asset = findAsset(release.assets, suffix);
      if (asset) return mirrorUrl(asset.browser_download_url);
    }
    return null;
  }

  /** Validate that the download mirror returns actual firmware bytes. */
  function checkProxyHealth(release) {
    if (proxyHealthChecked) return;
    proxyHealthChecked = true;

    const url = getHealthCheckUrl(release);
    if (!url) {
      showProxyBlocked();
      return;
    }

    fetch(url, { headers: { 'Range': 'bytes=0-1024' } })
      .then(function (res) {
        if (!res.ok && res.status !== 206) throw new Error('Download mirror responded with ' + res.status);
        return res.arrayBuffer().then(function (buf) {
          if (buf.byteLength === 0) throw new Error('Download mirror returned empty response');
          const view = new Uint8Array(buf);
          if (view[0] !== 0xE9) throw new Error('Download mirror returned invalid firmware data (no ESP image magic byte)');
          document.getElementById('installBtn').disabled = false;
          document.getElementById('proxyChecking').hidden = true;
        });
      })
      .catch(function (err) {
        console.warn('Download mirror health check failed - firmware downloads are likely blocked for this network.', err);
        showProxyBlocked();
      });
  }

  /** Run the one-time proxy check against the currently selected release. */
  function runInitialProxyCheck() {
    const opt = currentOption();
    if (opt && opt._release) checkProxyHealth(opt._release);
  }

  /** Load releases from cache/API, build UI options, and apply default selection. */
  function loadReleases() {
    const cached = getCachedReleases();
    const releasesPromise = cached
      ? Promise.resolve(cached)
      : fetch(GITHUB_RELEASES_URL + '?per_page=30')
        .then(function (res) {
          if (!res.ok) throw new Error('GitHub API responded with ' + res.status);
          return res.json();
        })
        .then(function (releases) {
          cacheReleases(releases);
          return releases;
        });

    releasesPromise
      .then(populateDropdown)
      .then(function () {
        applySelection();
        runInitialProxyCheck();
      })
      .catch(function (err) {
        console.warn('Failed to load WLED releases from the GitHub API.', err);
        showLoadError();
      });
  }

  // ---------------------------------------------------------------------
  // Build info (footer)
  // ---------------------------------------------------------------------
  // Shows when this copy of index.html/app.js was last built, so you can
  // tell a stale cached/deployed copy from a fresh one at a glance. Reads
  // build-info.json, a small file regenerated from git state by
  // tools/update_build_info.py (see tools/README.md) - not present until
  // that's been run at least once, so this fails silently (footer just
  // stays hidden) rather than showing an error on a fresh checkout.

  /** Fetch build-info.json (if present) and render it in the footer. */
  function loadBuildInfo() {
    fetch('build-info.json')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (info) {
        const date = new Date(info.builtAt);
        const formatted = isNaN(date) ? info.builtAt : date.toLocaleString();
        document.getElementById('buildInfoValue').textContent =
          formatted + ' (' + info.commit + (info.dirty ? '+' : '') + ')';
        document.getElementById('buildInfo').hidden = false;
      })
      .catch(function () { /* build-info.json not generated yet - stay hidden */ });
  }

  // ---------------------------------------------------------------------
  // Wire up DOM events once the document is ready
  // ---------------------------------------------------------------------

  /** Initialize page state and wire all UI event listeners. */
  function init() {
    checkSupported();
    if (typeof i18nInit === 'function') i18nInit();
    loadBuildInfo();

    document.getElementById('ver').addEventListener('change', applySelection);
    document.getElementById('uiModeRow').addEventListener('change', setManifest);
    document.getElementById('versionGroup').addEventListener('change', setManifest);
    document.getElementById('flashSizeRow').addEventListener('change', setManifest);
    document.getElementById('memoryTypeRow').addEventListener('change', setManifest);
    document.getElementById('flashModeRow').addEventListener('change', setManifest);
    document.getElementById('layoutRow').addEventListener('change', setManifest);
    document.getElementById('showSerialHelp').addEventListener('click', showSerialHelp);

    loadReleases();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
