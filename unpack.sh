#!/usr/bin/env bash
# unpack.sh - Unpack RDPrep NSIS installer into an editable Electron project
# Usage: ./unpack.sh <RDPrep_installer.exe> [output_dir]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn()    { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
error()   { printf "${RED}[-]${NC} %s\n" "$*" >&2; }
step()    { printf "${CYAN}[>]${NC} %s\n" "$*"; }

cleanup() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        error "Script failed with exit code $exit_code"
        if [[ -n "${TMPDIR:-}" && -d "$TMPDIR" ]]; then
            warn "Temp directory preserved for debugging: $TMPDIR"
        fi
    elif [[ -n "${TMPDIR:-}" && -d "$TMPDIR" ]]; then
        info "Cleaning up temp directory: $TMPDIR"
        rm -rf "$TMPDIR"
    fi
}
trap cleanup EXIT

usage() {
    cat <<EOF
Usage: $(basename "$0") <RDPrep_installer.exe> [output_dir]

Unpack an RDPrep NSIS Electron installer into a project directory
ready for modification and rebuilding.

Arguments:
  <RDPrep_installer.exe>  Path to the NSIS installer executable
  [output_dir]            Output directory (default: ./rdprep-unpacked)

Examples:
  $(basename "$0") RDPrep_3.2.1_win_x64.exe
  $(basename "$0") RDPrep_3.2.1_win_x64.exe my-project
EOF
    exit "${1:-0}"
}

check_prerequisites() {
    step "Checking prerequisites..."
    local missing=0

    if ! command -v 7z &>/dev/null; then
        error "7z not found. Install p7zip-full: sudo apt install p7zip-full"
        missing=1
    fi

    if ! command -v npx &>/dev/null; then
        error "npx not found. Install Node.js: https://nodejs.org"
        missing=1
    fi

    if ! command -v node &>/dev/null; then
        error "node not found. Install Node.js: https://nodejs.org"
        missing=1
    fi

    if [[ $missing -eq 1 ]]; then
        error "Missing required tools. Please install them and try again."
        exit 1
    fi

    info "All prerequisites satisfied"
}

extract_nsis() {
    local installer="$1"
    local nsis_dir="$2"

    step "Extracting NSIS installer..."
    7z x -y -o"$nsis_dir" "$installer" > /dev/null 2>&1
    info "NSIS installer extracted to: $nsis_dir"
}

find_and_extract_app_archive() {
    local nsis_dir="$1"
    local app_dir="$2"
    local archive

    archive=$(find "$nsis_dir" -name 'app-*.7z' -type f 2>/dev/null | head -n 1)

    if [[ -z "$archive" ]]; then
        archive=$(find "$nsis_dir" -name 'app-64.7z' -type f 2>/dev/null | head -n 1)
    fi

    if [[ -z "$archive" ]]; then
        archive=$(find "$nsis_dir" -name '*.7z' -type f 2>/dev/null | head -n 1)
    fi

    if [[ -z "$archive" ]]; then
        error "Could not find app archive (app-*.7z) in NSIS content"
        error "Available files in NSIS dir:"
        find "$nsis_dir" -type f 2>/dev/null | head -30 | while read -r f; do
            error "  $f"
        done
        exit 1
    fi

    step "Extracting app archive: $(basename "$archive")"
    7z x -y -o"$app_dir" "$archive" > /dev/null 2>&1
    info "App archive extracted to: $app_dir"
}

create_project_structure() {
    local app_dir="$1"
    local output_dir="$2"
    local nsis_dir="$3"

    step "Creating project structure..."

    if [[ ! -d "$app_dir/resources/app" ]]; then
        error "Expected resources/app/ not found in extracted archive"
        error "Looking for app directory..."
        local found_app
        found_app=$(find "$app_dir" -type d -name "app" 2>/dev/null | head -n 1)
        if [[ -n "$found_app" ]]; then
            error "Found app directory at: $found_app"
            error "But expected it at: $app_dir/resources/app"
        fi
        exit 1
    fi

    info "Copying resources/app/* to $output_dir/"
    rsync -a "$app_dir/resources/app/" "$output_dir/" 2>/dev/null || {
        mkdir -p "$output_dir"
        cp -a "$app_dir/resources/app/." "$output_dir/"
    }

    if [[ -f "$app_dir/resources/elevate.exe" ]]; then
        info "Copying elevate.exe to project root"
        cp -a "$app_dir/resources/elevate.exe" "$output_dir/elevate.exe"
    else
        warn "elevate.exe not found in resources/"
    fi

    local license_found=0
    local license_file
    license_file=$(find "$nsis_dir" -name "license.html" -type f 2>/dev/null | head -n 1)
    if [[ -n "$license_file" ]]; then
        mkdir -p "$output_dir/build"
        cp -a "$license_file" "$output_dir/build/License.html"
        info "Copied license to build/License.html"
        license_found=1
    fi

    if [[ $license_found -eq 0 ]]; then
        license_file=$(find "$nsis_dir" -name "License.html" -o -name "license.html" 2>/dev/null | head -n 1)
        if [[ -n "$license_file" ]]; then
            mkdir -p "$output_dir/build"
            cp -a "$license_file" "$output_dir/build/License.html"
            info "Copied license to build/License.html"
        else
            warn "License file not found in NSIS content"
        fi
    fi

    info "Project structure created at: $output_dir"
}

beautify_main_js() {
    local output_dir="$1"

    local main_min="$output_dir/main.min.js"
    local main_js="$output_dir/main.js"

    if [[ ! -f "$main_min" ]]; then
        warn "main.min.js not found, skipping beautification"
        return 0
    fi

    step "Beautifying main.min.js -> main.js"

    local version="unknown"
    local pkg_json="$output_dir/package.json"
    if [[ -f "$pkg_json" ]]; then
        version=$(node -e "
            try {
                const pkg = require('$pkg_json');
                console.log(pkg.version || 'unknown');
            } catch(e) { console.log('unknown'); }
        " 2>/dev/null || echo "unknown")
    fi

    local header="/**
 * main.js - RDPrep Electron Main Process
 *
 * Version:  ${version}
 * Original: main.min.js (minified TypeScript output)
 * Restored: $(date -u '+%Y-%m-%d %H:%M:%S UTC')
 *
 * This file was automatically de-minified from main.min.js.
 * Review carefully before modifying. Source map: main.js.map
 */
"

    npx --yes js-beautify --type js \
        --indent-size 2 \
        --preserve-newlines true \
        --wrap-line-length 120 \
        --unescape-strings true \
        "$main_min" > "$main_js" 2>/dev/null

    local tmp
    tmp=$(mktemp)
    printf '%s\n%s\n' "$header" "$(cat "$main_js")" > "$tmp"
    mv "$tmp" "$main_js"

    info "Beautified main.js created ($(wc -l < "$main_js") lines)"
}

update_package_json() {
    local output_dir="$1"
    local pkg_json="$output_dir/package.json"

    if [[ ! -f "$pkg_json" ]]; then
        error "package.json not found at: $pkg_json"
        exit 1
    fi

    step "Updating package.json..."

    node -e '
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));

pkg.main = "main.js";

pkg.scripts = pkg.scripts || {};
pkg.scripts.start = "electron .";
pkg.scripts.build = "grunt && electron-builder --config electron-builder-win32.json";
pkg.scripts["build:win"] = "grunt && electron-builder --win --config electron-builder-win32.json";

pkg.devDependencies = pkg.devDependencies || {};
if (!pkg.devDependencies.electron) {
    pkg.devDependencies.electron = "^28.0.0";
}
if (!pkg.devDependencies["electron-builder"]) {
    pkg.devDependencies["electron-builder"] = "^24.0.0";
}
if (!pkg.devDependencies.grunt) {
    pkg.devDependencies.grunt = "^1.6.0";
}
if (!pkg.devDependencies["grunt-contrib-uglify"]) {
    pkg.devDependencies["grunt-contrib-uglify"] = "^5.2.0";
}

fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
console.log("  main: " + pkg.main);
console.log("  scripts: " + Object.keys(pkg.scripts).join(", "));
' "$pkg_json"

    info "package.json updated"
}

update_electron_builder_config() {
    local output_dir="$1"

    local configs=(
        "$output_dir/electron-builder-win32.json"
        "$output_dir/electron-builder.json"
        "$output_dir/build/electron-builder-win32.json"
    )

    local config_file=""
    for f in "${configs[@]}"; do
        if [[ -f "$f" ]]; then
            config_file="$f"
            break
        fi
    done

    if [[ -z "$config_file" ]]; then
        warn "No electron-builder config found, creating electron-builder-win32.json"
        config_file="$output_dir/electron-builder-win32.json"
        cat > "$config_file" <<'DEFAULTCONFIG'
{
  "appId": "com.rdprep.app",
  "productName": "RDPrep",
  "directories": {
    "output": "release"
  },
  "files": [
    "**/*",
    "!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}",
    "!**/node_modules/.cache"
  ],
  "extraResources": [
    {
      "from": "elevate.exe",
      "to": "elevate.exe"
    }
  ],
  "win": {
    "target": "nsis"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}
DEFAULTCONFIG
        info "Created default electron-builder-win32.json"
        return 0
    fi

    step "Updating electron-builder config: $(basename "$config_file")"

    node -e '
const fs = require("fs");
const path = process.argv[1];
const config = JSON.parse(fs.readFileSync(path, "utf8"));

if (Array.isArray(config.files)) {
    config.files = config.files.filter(f => {
        if (typeof f === "string") {
            return !f.includes("!main.js") && !f.includes("!**/main.js");
        }
        return true;
    });
}

config.extraResources = config.extraResources || [];
const hasElevate = config.extraResources.some(r =>
    (r.from && r.from.includes("elevate")) || (r.to && r.to.includes("elevate"))
);
if (!hasElevate) {
    config.extraResources.push({ from: "elevate.exe", to: "elevate.exe" });
}

fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
console.log("  Updated files array and extraResources");
' "$config_file"

    info "Electron-builder config updated"
}

patch_api_urls() {
    local output_dir="$1"

    step "Patching API base URL and checkUpdateUrl..."

    local main_bundle
    main_bundle=$(find "$output_dir/dist" -name 'main.*.js' -type f 2>/dev/null | head -n 1)

    if [[ -z "$main_bundle" ]]; then
        warn "dist/main.*.js not found, skipping checkUpdateUrl patch"
        return 0
    fi

    sed -i 's|http://localhost:8774|https://efilingdownload2.rd.go.th|g' "$main_bundle"
    info "Patched base URL: localhost:8774 -> efilingdownload2.rd.go.th"
}

print_summary() {
    local output_dir="$1"
    local start_time="$2"

    local elapsed
    elapsed=$(( SECONDS - start_time ))

    echo ""
    printf "${GREEN}========================================${NC}\n"
    printf "${GREEN}   RDPrep Unpacked Successfully${NC}\n"
    printf "${GREEN}========================================${NC}\n"
    echo ""

    local total_files
    total_files=$(find "$output_dir" -type f 2>/dev/null | wc -l)
    local total_size
    total_size=$(du -sh "$output_dir" 2>/dev/null | cut -f1)

    printf "  ${CYAN}Output:${NC}      %s\n" "$output_dir"
    printf "  ${CYAN}Files:${NC}       %s\n" "$total_files"
    printf "  ${CYAN}Total size:${NC}  %s\n" "$total_size"
    printf "  ${CYAN}Elapsed:${NC}     %ds\n" "$elapsed"
    echo ""

    step "Key files:"
    [[ -f "$output_dir/main.js" ]]            && printf "  ${GREEN}✓${NC} main.js (beautified main process)\n"
    [[ -f "$output_dir/main.min.js" ]]        && printf "  ${GREEN}✓${NC} main.min.js (original)\n"
    [[ -f "$output_dir/main.js.map" ]]        && printf "  ${GREEN}✓${NC} main.js.map (source map)\n"
    [[ -f "$output_dir/package.json" ]]       && printf "  ${GREEN}✓${NC} package.json (updated)\n"
    [[ -f "$output_dir/elevate.exe" ]]        && printf "  ${GREEN}✓${NC} elevate.exe\n"
    [[ -d "$output_dir/dist" ]]               && printf "  ${GREEN}✓${NC} dist/ (Angular frontend)\n"
    [[ -d "$output_dir/common" ]]             && printf "  ${GREEN}✓${NC} common/ (backend modules)\n"
    [[ -d "$output_dir/plugins" ]]            && printf "  ${GREEN}✓${NC} plugins/ (backend modules)\n"
    [[ -d "$output_dir/node_modules" ]]       && printf "  ${GREEN}✓${NC} node_modules/\n"
    [[ -f "$output_dir/data/offline.db" ]]    && printf "  ${GREEN}✓${NC} data/offline.db (SQLite)\n"

    echo ""
    step "Applied patches:"
    printf "  ${GREEN}✓${NC} API base URL: localhost:8774 -> efilingdownload2.rd.go.th\n"

    echo ""
    step "Next steps:"
    echo "  1. cd $output_dir"
    echo "  2. npm install   (install devDependencies)"
    echo "  3. npm start     (launch the app for testing)"
    echo "  4. Edit main.js, dist/, common/, plugins/ as needed"
    echo "  5. npm run build (rebuild the installer)"
    echo ""
}

main() {
    local start_time=$SECONDS

    if [[ $# -lt 1 ]]; then
        usage 1
    fi

    local installer="$1"
    local output_dir="${2:-./rdprep-unpacked}"

    if [[ "$1" == "-h" || "$1" == "--help" ]]; then
        usage 0
    fi

    if [[ ! -f "$installer" ]]; then
        error "Installer not found: $installer"
        exit 1
    fi

    installer="$(cd "$(dirname "$installer")" && pwd)/$(basename "$installer")"
    output_dir="$(cd "$(dirname "$output_dir" 2>/dev/null || .)" && pwd)/$(basename "$output_dir")"

    echo ""
    printf "${CYAN}RDPrep NSIS Installer Unpacker${NC}\n"
    echo ""
    printf "  Installer:  %s\n" "$installer"
    printf "  Output:     %s\n" "$output_dir"
    echo ""

    check_prerequisites

    TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/rdprep-unpack.XXXXXX")
    local nsis_dir="$TMPDIR/nsis"
    local app_dir="$TMPDIR/app"
    mkdir -p "$nsis_dir" "$app_dir"

    info "Using temp directory: $TMPDIR"
    echo ""

    extract_nsis "$installer" "$nsis_dir"
    find_and_extract_app_archive "$nsis_dir" "$app_dir"
    create_project_structure "$app_dir" "$output_dir" "$nsis_dir"
    beautify_main_js "$output_dir"
    update_package_json "$output_dir"
    update_electron_builder_config "$output_dir"
    patch_api_urls "$output_dir"

    info "Removing temp directory: $TMPDIR"
    rm -rf "$TMPDIR"
    TMPDIR=""

    print_summary "$output_dir" "$start_time"
}

main "$@"
