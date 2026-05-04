// releases.js - Dynamic release loading from GitHub API for WLED Web Installer
//
// Fetches available WLED releases from the GitHub Releases API and dynamically
// populates the version dropdown. Generates esp-web-tools manifests on-the-fly
// as blob URLs, so the existing setManifest()/handleCheckbox() logic in script.js
// works unchanged.
//
// Falls back to the static <option> elements already in index.htm if the API
// request fails (e.g. rate-limited, offline, network error).

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const GITHUB_RELEASES_URL = 'https://api.github.com/repos/wled/WLED/releases';
  const CORS_PROXY = 'https://proxy.corsfix.com/?';
  const CACHE_KEY = 'wled_releases_cache';
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const MAX_STABLE_RELEASES = 8;   // limit dropdown length
  const MAX_BETA_RELEASES = 2;    // only show the two most recent beta releases

  // Base URL for locally-hosted bootloader / partition-table files.
  // These are chip-specific and shared across WLED versions.
  const bootBase = new URL('bin/boot/', window.location.href).href;

  // ---------------------------------------------------------------------------
  // Bootloader / partition configuration per chip family
  // ---------------------------------------------------------------------------
  // Each entry describes the boot-stage parts that must be flashed before the
  // WLED firmware binary. The firmware is always the last part.

  const CHIP_CONFIG = {
    'ESP32': {
      chipFamily: 'ESP32',
      bootParts: [
        { path: bootBase + 'esp32_bootloader_v4.bin', offset: 0 }
      ],
      firmwareOffset: 65536
    },
    'ESP32-C3': {
      chipFamily: 'ESP32-C3',
      bootParts: [
        { path: bootBase + 'esp32-c3_bootloader_v2.bin', offset: 0 }
      ],
      firmwareOffset: 65536
    },
    'ESP32-S2': {
      chipFamily: 'ESP32-S2',
      bootParts: [
        { path: bootBase + 'bootloader_s2.bin', offset: 4096 },
        { path: bootBase + 'partitions_s2_4m.bin', offset: 32768 }
      ],
      firmwareOffset: 65536
    },
    // ESP32-S3 comes in multiple flash sizes; each entry adds a flashSizeMB field
    // so the Jason2866 fork of esp-web-tools can select the right build automatically.
    'ESP32-S3-4M': {
      chipFamily: 'ESP32-S3',
      flashSizeMB: 4,
      bootParts: [
        { path: bootBase + 'bootloader_s3.bin', offset: 0 },
        { path: bootBase + 'partitions_s3_4m.bin', offset: 32768 }
      ],
      firmwareOffset: 65536
    },
    'ESP32-S3-8M': {
      chipFamily: 'ESP32-S3',
      flashSizeMB: 8,
      bootParts: [
        { path: bootBase + 'bootloader_s3.bin', offset: 0 },
        { path: bootBase + 'partitions_s3_8m.bin', offset: 32768 }
      ],
      firmwareOffset: 65536
    },
    'ESP32-S3-16M': {
      chipFamily: 'ESP32-S3',
      flashSizeMB: 16,
      bootParts: [
        { path: bootBase + 'bootloader_s3.bin', offset: 0 },
        { path: bootBase + 'partitions_s3_16m.bin', offset: 32768 }
      ],
      firmwareOffset: 65536
    },
    'ESP8266': {
      chipFamily: 'ESP8266',
      bootParts: [],
      firmwareOffset: 0
    }
  };

  // ---------------------------------------------------------------------------
  // Variant definitions
  // ---------------------------------------------------------------------------
  // Each variant maps chip families to the asset-name suffix used in GitHub
  // release assets.  Only chips that have a matching asset will be included in
  // the generated manifest; missing assets cause the variant's radio button to
  // be disabled automatically (existing handleCheckbox logic).

  const VARIANTS = {
    normal: {
      'ESP32':         '_ESP32.bin',
      'ESP32-C3':      '_ESP32-C3.bin',
      'ESP32-S2':      '_ESP32-S2.bin',
      // S3 flash-size variants — the Jason2866 fork detects flash size at runtime
      // and picks the best matching build (most-specific-first algorithm).
      'ESP32-S3-4M':   '_ESP32-S3_4M_qspi.bin',
      'ESP32-S3-8M':   '_ESP32-S3_8MB_opi.bin',
      'ESP32-S3-16M':  '_ESP32-S3_16MB_opi.bin',
      'ESP8266':       '_ESP8266.bin'
    },
    ethernet: {
      'ESP32':   '_ESP32_Ethernet.bin',
      'ESP8266': '_ESP8266.bin'
    },
    audio: {
      'ESP32': '_ESP32_audioreactive.bin'
    },
    test: {
      'ESP8266': '_ESP8266_160.bin'
    },
    v4: {
      'ESP32': '_ESP32_V4.bin'
    },
    debug: {
      'ESP32': '_ESP32_DEBUG.bin'
    }
  };

  // Maps variant names to the data-* attribute names expected by script.js
  const VARIANT_DATA_ATTRS = {
    normal:   'manifest',
    ethernet: 'ethernet',
    audio:    'audio',
    test:     'test',
    v4:       'v4',
    debug:    'debug'
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Find a release asset whose name ends with `suffix` (ignore .gz files). */
  function findAsset(assets, suffix) {
    return assets.find(function (a) {
      return a.name.endsWith(suffix) && !a.name.endsWith('.gz');
    }) || null;
  }

  /** Extract the WLED version string from asset filenames (for nightly). */
  function extractVersionFromAssets(assets) {
    for (let i = 0; i < assets.length; i++) {
      const m = assets[i].name.match(/^WLED_(.+?)_(ESP\d|ESP8)/);
      if (m) return m[1];
    }
    return 'unknown';
  }

  /** Human-readable version for the dropdown. */
  function getDisplayVersion(release) {
    if (release.tag_name === 'nightly') {
      return extractVersionFromAssets(release.assets) + ' Nightly';
    }
    return release.tag_name.replace(/^v/, '');
  }

  /** Version string embedded in the manifest JSON. */
  function getManifestVersion(release, variantName) {
    let ver;
    if (release.tag_name === 'nightly') {
      ver = extractVersionFromAssets(release.assets);
    } else {
      ver = release.tag_name.replace(/^v/, '');
    }
    if (variantName !== 'normal') {
      ver += ' ' + variantName;
    }
    return ver;
  }

  // ---------------------------------------------------------------------------
  // Manifest generation
  // ---------------------------------------------------------------------------

  /**
   * Build an esp-web-tools manifest object for the given release + variant.
   * Returns null if no matching assets are found for this variant.
   */
  function generateManifest(release, variantName) {
    const chipSuffixes = VARIANTS[variantName];
    const version = getManifestVersion(release, variantName);
    const builds = [];

    for (const chip in chipSuffixes) {
      const suffix = chipSuffixes[chip];
      const asset = findAsset(release.assets, suffix);
      if (!asset) continue;

      const config = CHIP_CONFIG[chip];
      if (!config) continue;

      const parts = config.bootParts.map(function (bp) {
        return { path: bp.path, offset: bp.offset };
      });

      parts.push({
        path: CORS_PROXY + asset.browser_download_url,
        offset: config.firmwareOffset
      });

      const build = { chipFamily: config.chipFamily, parts: parts };
      if (config.flashSizeMB) {
        build.flashSizeMB = config.flashSizeMB;
      }
      builds.push(build);
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

  /** Create a blob:// URL from a manifest object so esp-web-tools can fetch it. */
  function createManifestUrl(manifest) {
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    return URL.createObjectURL(blob);
  }

  // ---------------------------------------------------------------------------
  // Dropdown population
  // ---------------------------------------------------------------------------

  function categorize(release) {
    if (release.tag_name === 'nightly') return 'nightly';
    if (release.prerelease) return 'beta';
    return 'release';
  }

  /**
   * Create a single <option> element for a release.  All variant manifests are
   * pre-generated as blob URLs and stored in data-* attributes so that the
   * existing setManifest() / handleCheckbox() code works without changes.
   */
  function createOption(release) {
    const opt = document.createElement('option');
    opt.textContent = getDisplayVersion(release);
    opt.dataset.dynamic = 'true'; // mark as dynamically generated

    let hasPlain = false;
    for (const variant in VARIANT_DATA_ATTRS) {
      const manifest = generateManifest(release, variant);
      if (manifest) {
        opt.dataset[VARIANT_DATA_ATTRS[variant]] = createManifestUrl(manifest);
        if (variant === 'normal') hasPlain = true;
      }
    }

    // Every release must at least have the plain/normal variant
    return hasPlain ? opt : null;
  }

  /** Replace the <select> contents with dynamically generated options. */
  function populateDropdown(releases) {
    const sel = document.getElementById('ver');

    // Group by category
    const groups = { release: [], beta: [], nightly: [] };
    releases.forEach(function (r) {
      if (r.draft || !r.assets || r.assets.length === 0) return;
      groups[categorize(r)].push(r);
    });

    // Limit the number of stable releases shown
    if (groups.release.length > MAX_STABLE_RELEASES) {
      groups.release = groups.release.slice(0, MAX_STABLE_RELEASES);
    }
    // Limit the number of beta releases shown (only the two most recent)
    if (groups.beta.length > MAX_BETA_RELEASES) {
      groups.beta = groups.beta.slice(0, MAX_BETA_RELEASES);
    }

    // Build option groups
    const fragment = document.createDocumentFragment();

    if (groups.release.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Release';
      groups.release.forEach(function (r) {
        const opt = createOption(r);
        if (opt) grp.appendChild(opt);
      });
      if (grp.children.length > 0) fragment.appendChild(grp);
    }

    if (groups.beta.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Beta';
      groups.beta.forEach(function (r) {
        const opt = createOption(r);
        if (opt) grp.appendChild(opt);
      });
      if (grp.children.length > 0) fragment.appendChild(grp);
    }

    if (groups.nightly.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Nightly';
      groups.nightly.forEach(function (r) {
        const opt = createOption(r);
        if (opt) grp.appendChild(opt);
      });
      if (grp.children.length > 0) fragment.appendChild(grp);
    }

    // Only replace contents if we actually produced options
    if (fragment.children.length > 0) {
      sel.innerHTML = '';
      sel.appendChild(fragment);
    }
  }

  // ---------------------------------------------------------------------------
  // Caching (sessionStorage, 5-minute TTL)
  // ---------------------------------------------------------------------------

  function getCachedReleases() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.timestamp < CACHE_TTL) return data.releases;
    } catch (e) {
      console.warn('Failed to read releases cache:', e);
    }
    return null;
  }

  function cacheReleases(releases) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        releases: releases
      }));
    } catch (e) {
      console.warn('Failed to write releases cache:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  /**
   * Safely call resetCheckboxes() and setManifest() from script.js.
   * These are defined in script.js which loads before releases.js, but we add
   * defensive checks for robustness.
   */
  function applySelection() {
    if (typeof resetCheckboxes === 'function') resetCheckboxes();
    if (typeof setManifest === 'function') setManifest();
  }

  /**
   * Fetch releases and populate the dropdown.  On failure the existing static
   * <option> elements in the HTML remain untouched, so the installer still
   * works (just with the hardcoded version list).
   */
  window.loadReleases = function loadReleases() {
    const cached = getCachedReleases();
    if (cached) {
      populateDropdown(cached);
      applySelection();
      return;
    }

    fetch(GITHUB_RELEASES_URL + '?per_page=30')
      .then(function (res) {
        if (!res.ok) throw new Error('GitHub API responded with ' + res.status);
        return res.json();
      })
      .then(function (releases) {
        cacheReleases(releases);
        populateDropdown(releases);
        applySelection();
      })
      .catch(function (err) {
        console.warn('Failed to load releases from GitHub API – using static fallback.', err);
        // Static options remain in place; setManifest() was already called
        // by checkSupported() during page load, so no action needed.
      });
  };
})();
