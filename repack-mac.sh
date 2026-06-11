#!/usr/bin/env bash
# repack.sh - Rebuild and repackage RDPrep Electron app into NSIS installer
# Usage: ./repack.sh [options] [project_dir] [output_dir]
set -euo pipefail

readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_DIR=""
OUTPUT_DIR=""
QUICK_MODE=false
CLEAN_MODE=false
VERSION_BUMP=""
STEP=0
TOTAL_STEPS=5

print_banner() {
    echo -e "${CYAN}"
    echo "  ╔═══════════════════════════════════════════╗"
    echo "  ║         RDPrep NSIS Repack Tool          ║"
    echo "  ╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

usage() {
    print_banner
    cat <<EOF
Usage: $SCRIPT_NAME [options] [project_dir] [output_dir]

Repackage the RDPrep Electron application into an NSIS installer (.exe).

Modes:
  Default             Full rebuild (npm install + grunt + electron-builder)
  --quick             Quick repack - skip npm install and grunt, just repackage
  --clean             Remove node_modules before npm install
  --version VER       Bump package.json version before building

Options:
  project_dir         Path to rdprep-electron/ (default: ./rdprep-electron)
  output_dir          Where to copy the final installer (default: project_dir/release)
  -h, --help          Show this help message

Examples:
  $SCRIPT_NAME                              Build with defaults
  $SCRIPT_NAME --quick                      Quick repack without rebuild
  $SCRIPT_NAME --version 1.4.0             Bump version to 1.4.0 and build
  $SCRIPT_NAME --clean                      Clean install and full rebuild
  $SCRIPT_NAME ./rdprep-electron ./out      Specify paths

EOF
    exit 0
}

die() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
    exit 1
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

step() {
    STEP=$((STEP + 1))
    echo ""
    echo -e "${BOLD}${CYAN}═══ Step ${STEP}/${TOTAL_STEPS}: $* ═══${NC}"
    echo ""
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --quick|-q)
                QUICK_MODE=true
                TOTAL_STEPS=2
                shift
                ;;
            --clean|-c)
                CLEAN_MODE=true
                shift
                ;;
            --version|-v)
                if [[ -z "${2:-}" ]]; then
                    die "--version requires a version string (e.g. --version 1.4.0)"
                fi
                VERSION_BUMP="$2"
                shift 2
                ;;
            --help|-h)
                usage
                ;;
            -*)
                die "Unknown option: $1\nRun '$SCRIPT_NAME --help' for usage."
                ;;
            *)
                if [[ -z "$PROJECT_DIR" ]]; then
                    PROJECT_DIR="$1"
                elif [[ -z "$OUTPUT_DIR" ]]; then
                    OUTPUT_DIR="$1"
                else
                    die "Unexpected argument: $1"
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$PROJECT_DIR" ]]; then
        PROJECT_DIR="${SCRIPT_DIR}/rdprep-electron"
    fi

    if [[ -z "$OUTPUT_DIR" ]]; then
        OUTPUT_DIR=""
    fi
}

validate_project_dir() {
    [[ -d "$PROJECT_DIR" ]] || die "Project directory not found: $PROJECT_DIR"
    [[ -f "$PROJECT_DIR/package.json" ]] || die "package.json not found in: $PROJECT_DIR"
    [[ -f "$PROJECT_DIR/electron-builder-win32.json" ]] || die "electron-builder-win32.json not found in: $PROJECT_DIR"
    [[ -f "$PROJECT_DIR/main.js" ]] || die "main.js not found in: $PROJECT_DIR"
}

check_prerequisites() {
    step "Checking prerequisites"

    local missing=()

    if ! command -v node &>/dev/null; then
        missing+=("node")
    else
        local node_ver
        node_ver="$(node --version)"
        success "Node.js ${node_ver}"
    fi

    if ! command -v npm &>/dev/null; then
        missing+=("npm")
    else
        local npm_ver
        npm_ver="$(npm --version)"
        success "npm ${npm_ver}"
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        die "Missing required tools: ${missing[*]}\nInstall them from https://nodejs.org/"
    fi

    local pkg_name
    pkg_name="$(node -e "
        const pkg = require('$PROJECT_DIR/package.json');
        console.log(pkg.name + ' v' + pkg.version);
    ")"
    info "Project: ${pkg_name}"
    success "All prerequisites met"
}

bump_version() {
    if [[ -z "$VERSION_BUMP" ]]; then
        return 0
    fi

    step "Bumping version to ${VERSION_BUMP}"

    if [[ ! "$VERSION_BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        die "Invalid version format: ${VERSION_BUMP} (expected semver: X.Y.Z)"
    fi

    local old_ver
    old_ver="$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")"

    node -e "
        const fs = require('fs');
        const path = '$PROJECT_DIR/package.json';
        const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
        pkg.version = '$VERSION_BUMP';
        fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    "

    success "Version updated: ${old_ver} -> ${VERSION_BUMP}"
}

install_dependencies() {
    step "Installing dependencies"

    if [[ "$CLEAN_MODE" == true ]]; then
        info "Removing node_modules (clean mode)..."
        rm -rf "${PROJECT_DIR}/node_modules"
        success "node_modules removed"
    fi

    if [[ -d "${PROJECT_DIR}/node_modules" ]]; then
        local nm_count
        nm_count="$(find "${PROJECT_DIR}/node_modules" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)"
        info "node_modules exists with ~${nm_count} packages"

        local dep_count
        dep_count="$(node -e "
            const pkg = require('$PROJECT_DIR/package.json');
            const deps = Object.keys(pkg.dependencies || {});
            const devDeps = Object.keys(pkg.devDependencies || {});
            console.log(deps.length + devDeps.length);
        ")"

        if [[ "$nm_count" -lt "$dep_count" ]]; then
            warn "node_modules seems incomplete (${nm_count} packages vs ${dep_count} declared)"
            info "Running npm install..."
            npm install --prefix "$PROJECT_DIR" || die "npm install failed"
        else
            info "node_modules appears complete, skipping npm install"
            info "Use --clean to force a fresh install"
        fi
    else
        info "Running npm install..."
        npm install --prefix "$PROJECT_DIR" || die "npm install failed"
    fi

    success "Dependencies ready"
}

run_grunt() {
    step "Running Grunt (minifying JS)"

    [[ -f "${PROJECT_DIR}/Gruntfile.js" ]] || die "Gruntfile.js not found"

    if [[ ! -d "${PROJECT_DIR}/node_modules/grunt" ]]; then
        warn "grunt not in node_modules, installing..."
        npm install --prefix "$PROJECT_DIR" grunt grunt-contrib-uglify --save-dev || die "Failed to install grunt"
    fi

    info "Minifying main.js -> main.min.js and uglifying common/ and plugins/..."
    (
        cd "$PROJECT_DIR"
        npx grunt --no-color
    ) || die "Grunt build failed"

    if [[ -f "${PROJECT_DIR}/main.min.js" ]]; then
        local main_size
        main_size="$(stat -c%s "${PROJECT_DIR}/main.min.js" 2>/dev/null || stat -f%z "${PROJECT_DIR}/main.min.js")"
        success "main.min.js generated (${main_size} bytes)"
    else
        warn "main.min.js was not generated by grunt"
    fi

    success "Grunt tasks completed"
}

clean_release_dir() {
    local release_dir="${PROJECT_DIR}/release"
    if [[ -d "$release_dir" ]]; then
        info "Cleaning old release directory..."
        rm -rf "$release_dir"
        success "Removed ${release_dir}"
    fi
}

run_electron_builder() {
    step "Running electron-builder (creating NSIS installer)"

    if [[ ! -d "${PROJECT_DIR}/node_modules/electron-builder" ]]; then
        warn "electron-builder not found, installing as devDependency..."
        npm install --prefix "$PROJECT_DIR" electron-builder --save-dev || die "Failed to install electron-builder"
    fi

    clean_release_dir

    info "Building NSIS installer..."
    info "  Config: electron-builder-win32.json"
    info "  Target: win (nsis)"
    info "  ASAR:   disabled"

    (
        cd "$PROJECT_DIR"
        npx electron-builder --win --config electron-builder-win32.json
    ) || die "electron-builder failed"

    success "electron-builder completed"
}

copy_output() {
    local release_dir="${PROJECT_DIR}/release"

    if [[ -z "$OUTPUT_DIR" ]]; then
        return 0
    fi

    mkdir -p "$OUTPUT_DIR"

    local found_exe=false
    for exe in "${release_dir}"/*.exe; do
        if [[ -f "$exe" ]]; then
            cp "$exe" "$OUTPUT_DIR/"
            success "Copied $(basename "$exe") -> ${OUTPUT_DIR}/"
            found_exe=true
        fi
    done

    if [[ "$found_exe" == false ]]; then
        warn "No .exe files found in ${release_dir} to copy"
    fi
}

verify_output() {
    step "Verifying output"

    local release_dir="${PROJECT_DIR}/release"

    if [[ ! -d "$release_dir" ]]; then
        die "Release directory not found: ${release_dir}"
    fi

    local exe_files=()
    while IFS= read -r -d '' f; do
        exe_files+=("$f")
    done < <(find "$release_dir" -maxdepth 1 -name "*.exe" -print0 2>/dev/null)

    if [[ ${#exe_files[@]} -eq 0 ]]; then
        die "No .exe installer found in ${release_dir}"
    fi

    echo -e "\n${GREEN}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║          Build Successful!                        ║${NC}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════╣${NC}"

    local exe_path
    for exe_path in "${exe_files[@]}"; do
        local exe_name
        exe_name="$(basename "$exe_path")"
        local exe_size
        exe_size="$(stat -c%s "$exe_path" 2>/dev/null || stat -f%z "$exe_path")"
        local size_mb
        size_mb="$(echo "scale=2; ${exe_size} / 1048576" | bc 2>/dev/null || echo "unknown")"

        echo -e "${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}  Installer: ${BOLD}${exe_name}${NC}"
        echo -e "${GREEN}║${NC}  Path:      ${exe_path}"
        echo -e "${GREEN}║${NC}  Size:      ${size_mb} MB (${exe_size} bytes)"
    done

    echo -e "${GREEN}║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
    echo ""
}

main() {
    parse_args "$@"
    print_banner

    validate_project_dir

    if [[ "$QUICK_MODE" == true ]]; then
        info "Mode: ${BOLD}Quick Repack${NC} (skip npm install and grunt)"
        check_prerequisites
        bump_version
        run_electron_builder
    else
        info "Mode: ${BOLD}Full Rebuild${NC}"
        check_prerequisites
        bump_version
        install_dependencies
        run_grunt
        run_electron_builder
    fi

    copy_output
    verify_output
}

main "$@"
