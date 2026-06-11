# MacOS-RDPrep

macOS build of the Thai Revenue Department's RDPrep e-Filing desktop application, originally distributed as a Windows-only Electron/NSIS installer.

> **Disclaimer: This project is intended solely for educational and research purposes.**

## Purpose

This project demonstrates how to:

- Extract and reverse-engineer an NSIS-packaged Electron application
- De-minify production JavaScript for code analysis
- Cross-compile an Electron app for macOS from a Windows binary
- Automate the entire pipeline with GitHub Actions

**This project is not affiliated with, endorsed by, or connected to the Thai Revenue Department (กรมสรรพากร).**

## Legal Notice

- The original RDPrep software is property of the Thai Revenue Department
- This project does **not** redistribute the original installer or any proprietary source code
- The build pipeline downloads the original installer directly from the official government server (`rdserverdoc.rd.go.th`)
- Users are responsible for ensuring compliance with applicable laws and the original software's license terms
- This repository contains **no binaries** — only build scripts and CI configuration

## How It Works

The GitHub Actions workflow (`build-macos.yml`) performs two steps:

1. **Unpack** (Ubuntu runner) — Downloads the official Windows `.exe`, extracts the NSIS archive, unpacks the inner Electron app, de-minifies `main.min.js`, and patches configs for macOS
2. **Build** (macOS runner) — Rebuilds native modules (`sqlite3`, `bcrypt`) against Electron's Node.js headers, then packages the app as a DMG

## Usage

### Trigger a build

Go to **Actions → Build macOS → Run workflow**. Optionally provide a custom download URL and version tag.

### Local unpack

```bash
# Download the installer first
curl -L -o RDPrep.exe "https://rdserverdoc.rd.go.th/prog_download/RDPrep_1.3.2_win_x64.exe"

# Extract into editable project
./unpack.sh RDPrep.exe rdprep-project
```

### Local build (macOS only)

```bash
cd rdprep-project
npm install --ignore-scripts
npx electron-rebuild -f -w sqlite3 bcrypt
npx electron-builder --mac --config electron-builder-mac.json --x64
```

## Technical Details

| Component | Details |
|---|---|
| Original app | `rd-efiling-desktop` v1.3.2 |
| Framework | Electron 8.5.5 (rebuilt with 22.3.27) |
| Frontend | Angular (in `dist/`) |
| Backend | Node.js (in `common/`, `plugins/`) |
| Native modules | `sqlite3@5.0.0`, `bcrypt@5.0.1` |
| Packager | electron-builder |
| Source recovery | `main.min.js` de-minified via `js-beautify` |

## Repository Structure

```
.github/workflows/build-macos.yml   # CI pipeline
unpack.sh                            # Extracts NSIS → Electron project
repack-mac.sh                        # Repackages for macOS
.gitignore
README.md
```

## License

This repository's scripts and configuration are provided as-is for educational purposes. The original RDPrep software remains the property of its respective owners.
