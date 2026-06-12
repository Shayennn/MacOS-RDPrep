#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BOOTSTRAP_FILE = "rdprep-bootstrap.js";
const DEFAULT_RUNTIME_ENTRY = "main.js";

function normalizeEntry(entry) {
  if (typeof entry !== "string") {
    return DEFAULT_RUNTIME_ENTRY;
  }

  let normalized = entry.trim().replace(/\\/g, "/");

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  if (normalized === "" || normalized === ".") {
    return DEFAULT_RUNTIME_ENTRY;
  }

  return normalized;
}

function isAbsoluteEntry(entry) {
  return path.isAbsolute(entry) || path.win32.isAbsolute(entry);
}

function resolveEntryPath(appDir, entry) {
  const normalized = normalizeEntry(entry);
  return isAbsoluteEntry(normalized) ? normalized : path.join(appDir, normalized);
}

function isExistingFile(appDir, entry) {
  try {
    return fs.statSync(resolveEntryPath(appDir, entry)).isFile();
  } catch (_error) {
    return false;
  }
}

function resolveRuntimeEntry(appDir, pkg) {
  const packageMain = normalizeEntry(pkg && pkg.main);
  const bootstrapMetadata = pkg && typeof pkg.rdprepBootstrap === "object" && pkg.rdprepBootstrap !== null
    ? pkg.rdprepBootstrap
    : null;

  if (
    packageMain === BOOTSTRAP_FILE &&
    bootstrapMetadata &&
    typeof bootstrapMetadata.runtimeEntry === "string" &&
    bootstrapMetadata.runtimeEntry.trim() !== ""
  ) {
    const runtimeEntry = normalizeEntry(bootstrapMetadata.runtimeEntry);
    if (isExistingFile(appDir, runtimeEntry)) {
      return runtimeEntry;
    }
  }

  if (isExistingFile(appDir, DEFAULT_RUNTIME_ENTRY)) {
    return DEFAULT_RUNTIME_ENTRY;
  }

  if (packageMain !== BOOTSTRAP_FILE && isExistingFile(appDir, packageMain)) {
    return packageMain;
  }

  return DEFAULT_RUNTIME_ENTRY;
}

function toRequirePath(entry) {
  const normalized = normalizeEntry(entry);

  if (isAbsoluteEntry(normalized)) {
    return normalized;
  }

  return `./${normalized}`;
}

function buildBootstrapSource(runtimeEntry) {
  const runtimeRequirePath = toRequirePath(runtimeEntry);

  return `"use strict";

const RDPREP_RUNTIME_ENTRY = ${JSON.stringify(runtimeRequirePath)};

const electron = require("electron");

if (!electron || !electron.app || !electron.ipcMain || !electron.BrowserWindow) {
  throw new Error("RDPrep bootstrap requires Electron app, ipcMain, and BrowserWindow APIs");
}

const app = electron.app;
const ipcMain = electron.ipcMain;
const bootstrapConsoleError = console.error.bind(console);
const APPLIED_SYMBOL = Symbol.for("rdprep.bootstrap.applied");
const CONSOLE_PATCHED_SYMBOL = Symbol.for("rdprep.bootstrap.consolePatched");
const RENDERER_HELPER_ATTACHED_SYMBOL = Symbol.for("rdprep.bootstrap.rendererHelperAttached");
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
let activeProxyUrl = null;
const RENDERER_HELPER_SOURCE = [
  "(function() {",
  "  if (window.__rdprepSetProxyInstalled) { return; }",
  "  Object.defineProperty(window, '__rdprepSetProxyInstalled', { value: true, configurable: true });",
  "  window.setProxy = function(url) { return require('electron').ipcRenderer.sendSync('set-proxy', url == null ? null : String(url)); };",
  "  console.log('[RDPrep bootstrap] window.setProxy helper installed');",
  "})();"
].join("\\n");

if (!electron[APPLIED_SYMBOL]) {
  defineFlag(electron, APPLIED_SYMBOL);
  applyBootstrap();
}

require(RDPREP_RUNTIME_ENTRY);

function applyBootstrap() {
  patchBrowserWindowConstructor();
  registerRendererHelperInjection();
  registerProxyHandler();
  patchConsoleForwarding();
}

function defineFlag(target, symbol) {
  try {
    Object.defineProperty(target, symbol, {
      value: true,
      enumerable: false,
      configurable: false
    });
  } catch (_error) {
    target[symbol] = true;
  }
}

function logBootstrapError(context, error) {
  const message = error && error.stack ? error.stack : error && error.message ? error.message : String(error);

  try {
    bootstrapConsoleError("[RDPrep bootstrap] " + context + ":", message);
  } catch (_error) {
  }
}

function patchBrowserWindowConstructor() {
  const OriginalBrowserWindow = electron.BrowserWindow;

  if (OriginalBrowserWindow[APPLIED_SYMBOL]) {
    return;
  }

  function RDPrepBrowserWindow(options) {
    return Reflect.construct(
      OriginalBrowserWindow,
      [patchBrowserWindowOptions(options)],
      new.target || OriginalBrowserWindow
    );
  }

  RDPrepBrowserWindow.prototype = OriginalBrowserWindow.prototype;
  Object.setPrototypeOf(RDPrepBrowserWindow, OriginalBrowserWindow);
  copyStaticMembers(OriginalBrowserWindow, RDPrepBrowserWindow);
  defineFlag(RDPrepBrowserWindow, APPLIED_SYMBOL);

  try {
    electron.BrowserWindow = RDPrepBrowserWindow;
  } catch (_error) {
    try {
      Object.defineProperty(electron, "BrowserWindow", {
        value: RDPrepBrowserWindow,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } catch (defineError) {
      logBootstrapError("BrowserWindow patch failed (Electron getter is read-only)", defineError);
      return;
    }
  }
}

function patchBrowserWindowOptions(options) {
  const patchedOptions = Object.assign({}, options || {});
  const webPreferences = Object.assign({}, patchedOptions.webPreferences || {});

  webPreferences.nodeIntegration = true;
  webPreferences.contextIsolation = false;
  webPreferences.sandbox = false;
  webPreferences.devTools = true;
  patchedOptions.webPreferences = webPreferences;

  return patchedOptions;
}

function copyStaticMembers(source, target) {
  const skippedProperties = new Set(["length", "name", "prototype", "arguments", "caller"]);

  Object.getOwnPropertyNames(source).forEach(function(propertyName) {
    if (!skippedProperties.has(propertyName)) {
      copyPropertyDescriptor(source, target, propertyName);
    }
  });

  Object.getOwnPropertySymbols(source).forEach(function(propertySymbol) {
    copyPropertyDescriptor(source, target, propertySymbol);
  });
}

function copyPropertyDescriptor(source, target, propertyKey) {
  try {
    Object.defineProperty(target, propertyKey, Object.getOwnPropertyDescriptor(source, propertyKey));
  } catch (_error) {
  }
}

function registerRendererHelperInjection() {
  app.on("browser-window-created", function(_event, browserWindow) {
    attachRendererHelper(browserWindow);
  });

  getAllBrowserWindows().forEach(function(browserWindow) {
    attachRendererHelper(browserWindow);
  });
}

function attachRendererHelper(browserWindow) {
  const webContents = browserWindow && browserWindow.webContents;

  if (!webContents || typeof webContents.on !== "function" || webContents[RENDERER_HELPER_ATTACHED_SYMBOL]) {
    return;
  }

  defineFlag(webContents, RENDERER_HELPER_ATTACHED_SYMBOL);
  webContents.on("did-finish-load", function() {
    injectRendererHelper(webContents);
  });
}

function injectRendererHelper(webContents) {
  if (!webContents || typeof webContents.executeJavaScript !== "function") {
    return;
  }

  try {
    const injection = webContents.executeJavaScript(RENDERER_HELPER_SOURCE, true);
    if (injection && typeof injection.catch === "function") {
      injection.catch(function(error) {
        logBootstrapError("renderer helper injection failed", error);
      });
    }
  } catch (error) {
    logBootstrapError("renderer helper injection failed", error);
  }
}

function registerProxyHandler() {
  ipcMain.on("set-proxy", function(event, proxyUrl) {
    const parsedProxy = parseProxyInput(proxyUrl);

    if (!parsedProxy.ok) {
      if (event) {
        event.returnValue = activeProxyUrl;
      }
      return;
    }

    try {
      setAxiosProxy(parsedProxy.proxyUrl, parsedProxy.axiosProxy);
    } catch (error) {
      logBootstrapError("axios proxy configuration failed", error);
      if (event) {
        event.returnValue = activeProxyUrl;
      }
      return;
    }

    setEnvironmentProxy(parsedProxy.proxyUrl);
    activeProxyUrl = parsedProxy.proxyUrl;
    setElectronSessionProxy(activeProxyUrl);

    if (event) {
      event.returnValue = activeProxyUrl;
    }
  });
}

function parseProxyInput(proxyUrl) {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);

  if (normalizedProxyUrl === null) {
    return { ok: true, proxyUrl: null, axiosProxy: null };
  }

  try {
    const parsedProxy = new URL(normalizedProxyUrl);
    return {
      ok: true,
      proxyUrl: parsedProxy.href,
      axiosProxy: buildAxiosProxyConfig(parsedProxy)
    };
  } catch (error) {
    logBootstrapError("invalid proxy input " + normalizedProxyUrl, error);
    return { ok: false };
  }
}

function normalizeProxyUrl(proxyUrl) {
  if (proxyUrl == null) {
    return null;
  }

  const normalizedProxyUrl = String(proxyUrl).trim();
  return normalizedProxyUrl === "" ? null : normalizedProxyUrl;
}

function buildAxiosProxyConfig(parsedProxy) {
  const axiosProxy = {
    protocol: parsedProxy.protocol.replace(/:$/, ""),
    host: parsedProxy.hostname
  };

  if (parsedProxy.port) {
    axiosProxy.port = Number(parsedProxy.port);
  }

  if (parsedProxy.username || parsedProxy.password) {
    axiosProxy.auth = {
      username: decodeURIComponent(parsedProxy.username),
      password: decodeURIComponent(parsedProxy.password)
    };
  }

  return axiosProxy;
}

function setEnvironmentProxy(proxyUrl) {
  PROXY_ENV_KEYS.forEach(function(environmentKey) {
    if (proxyUrl) {
      process.env[environmentKey] = proxyUrl;
    } else {
      delete process.env[environmentKey];
    }
  });
}

function setAxiosProxy(proxyUrl, axiosProxyConfig) {
  let axios;

  try {
    axios = require("axios");
  } catch (_error) {
    return;
  }

  if (!axios || !axios.defaults) {
    return;
  }

  if (!proxyUrl) {
    axios.defaults.proxy = false;
    return;
  }

  axios.defaults.proxy = axiosProxyConfig;
}

function setElectronSessionProxy(proxyUrl) {
  const proxyConfig = { proxyRules: proxyUrl || "" };

  if (electron.session) {
    setProxyOnSession(electron.session.defaultSession, proxyConfig);
  }

  getAllBrowserWindows().forEach(function(browserWindow) {
    setProxyOnSession(
      browserWindow && browserWindow.webContents && browserWindow.webContents.session,
      proxyConfig
    );
  });
}

function setProxyOnSession(electronSession, proxyConfig) {
  if (!electronSession || typeof electronSession.setProxy !== "function") {
    return;
  }

  try {
    const proxyResult = electronSession.setProxy(proxyConfig);
    if (proxyResult && typeof proxyResult.catch === "function") {
      proxyResult.catch(function(error) {
        logBootstrapError("session.setProxy failed", error);
      });
    }
  } catch (error) {
    logBootstrapError("session.setProxy failed", error);
  }
}

function patchConsoleForwarding() {
  if (console[CONSOLE_PATCHED_SYMBOL]) {
    return;
  }

  defineFlag(console, CONSOLE_PATCHED_SYMBOL);
  wrapConsoleMethod("log");
  wrapConsoleMethod("error");
}

function wrapConsoleMethod(methodName) {
  const originalMethod = console[methodName];

  if (typeof originalMethod !== "function") {
    return;
  }

  console[methodName] = function rdprepConsoleForwarder() {
    const args = Array.prototype.slice.call(arguments);

    originalMethod.apply(console, args);
    forwardConsoleMessage(methodName, args);
  };
}

function forwardConsoleMessage(methodName, args) {
  const script = "console." + methodName + "(" + args.map(toJavaScriptLiteral).join(", ") + ");";

  getAllBrowserWindows().forEach(function(browserWindow) {
    const webContents = browserWindow && browserWindow.webContents;

    if (!webContents || typeof webContents.executeJavaScript !== "function") {
      return;
    }

    try {
      const forwardResult = webContents.executeJavaScript(script, true);
      if (forwardResult && typeof forwardResult.catch === "function") {
        forwardResult.catch(function() {});
      }
    } catch (_error) {
    }
  });
}

function toJavaScriptLiteral(value) {
  if (typeof value === "undefined") {
    return "undefined";
  }

  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    return JSON.stringify(String(value));
  }

  if (value instanceof Error) {
    return JSON.stringify(value.stack || value.message || String(value));
  }

  try {
    const jsonValue = JSON.stringify(value);
    return typeof jsonValue === "undefined" ? JSON.stringify(String(value)) : jsonValue;
  } catch (_error) {
    return JSON.stringify(String(value));
  }
}

function getAllBrowserWindows() {
  const BrowserWindow = electron.BrowserWindow;

  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") {
    return [];
  }

  try {
    return BrowserWindow.getAllWindows() || [];
  } catch (_error) {
    return [];
  }
}
`;
}

function installBootstrap(appDir) {
  const resolvedAppDir = path.resolve(appDir || process.cwd());
  const packagePath = path.join(resolvedAppDir, "package.json");

  if (!fs.existsSync(packagePath)) {
    throw new Error(`package.json not found: ${packagePath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const runtimeEntry = resolveRuntimeEntry(resolvedAppDir, pkg);
  const runtimePath = resolveEntryPath(resolvedAppDir, runtimeEntry);

  if (!isExistingFile(resolvedAppDir, runtimeEntry)) {
    throw new Error(`Runtime entrypoint not found: ${runtimePath}`);
  }

  const bootstrapPath = path.join(resolvedAppDir, BOOTSTRAP_FILE);

  fs.writeFileSync(bootstrapPath, buildBootstrapSource(runtimeEntry), "utf8");

  pkg.main = BOOTSTRAP_FILE;
  pkg.rdprepBootstrap = { runtimeEntry };
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  return {
    appDir: resolvedAppDir,
    bootstrapFile: BOOTSTRAP_FILE,
    bootstrapPath,
    runtimeEntry
  };
}

function printHelp() {
  console.log("Usage: install-bootstrap [app-dir]");
  console.log("Installs rdprep-bootstrap.js and points package.json main at it.");
}

function main(argv) {
  const args = argv || process.argv;
  const appDir = args[2];

  if (appDir === "-h" || appDir === "--help") {
    printHelp();
    process.exitCode = 0;
    return null;
  }

  try {
    const result = installBootstrap(appDir || process.cwd());
    console.log("RDPrep bootstrap installed:");
    console.log(`  bootstrap: ${result.bootstrapFile}`);
    console.log(`  runtime: ${result.runtimeEntry}`);
    console.log(`  package main: ${BOOTSTRAP_FILE}`);
    process.exitCode = 0;
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`install-bootstrap failed: ${message}`);
    process.exitCode = 1;
    return null;
  }
}

module.exports = {
  BOOTSTRAP_FILE,
  DEFAULT_RUNTIME_ENTRY,
  buildBootstrapSource,
  installBootstrap,
  main,
  normalizeEntry,
  resolveRuntimeEntry,
  toRequirePath
};

if (require.main === module) {
  main(process.argv);
}
