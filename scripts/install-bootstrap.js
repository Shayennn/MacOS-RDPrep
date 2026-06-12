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
const HTTPS_TUNNEL_ORIGINAL_SYMBOL = Symbol.for("rdprep.bootstrap.httpsTunnelOriginalCreateConnection");
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
  disableAxiosBuiltInProxy();
  registerProxyHandler();
  applyEnvironmentProxyOnReady();
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

  // In Electron 22+ electron.BrowserWindow is a NON-configurable getter, so both
  // "electron.BrowserWindow = X" and Object.defineProperty(electron, ...) throw and
  // the patch silently no-ops. Without it the app's windows keep Electron 22 defaults
  // (contextIsolation:true, sandbox:true), the nodeIntegration renderer loses Node
  // access, Angular fails to bootstrap, and the window stays blank/white.
  // We instead intercept require("electron") so the runtime entry receives a facade
  // whose BrowserWindow is our wrapper while every other member delegates to the real
  // module. This needs no write to the read-only getter.
  installElectronRequireInterception(RDPrepBrowserWindow);
}

function installElectronRequireInterception(patchedBrowserWindow) {
  const Module = require("module");

  if (Module[APPLIED_SYMBOL]) {
    return;
  }
  defineFlag(Module, APPLIED_SYMBOL);

  const electronFacade = Object.create(electron);
  Object.defineProperty(electronFacade, "BrowserWindow", {
    value: patchedBrowserWindow,
    enumerable: true,
    configurable: true,
    writable: true
  });

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function rdprepElectronRequire(request) {
    if (request === "electron") {
      return electronFacade;
    }
    return originalRequire.apply(this, arguments);
  };
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

    if (parsedProxy.ok) {
      applyProxyConfiguration(parsedProxy.proxyUrl);
    }

    if (event) {
      event.returnValue = activeProxyUrl;
    }
  });
}

function applyEnvironmentProxyOnReady() {
  const environmentProxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || null;
  const parsedProxy = parseProxyInput(environmentProxyUrl);

  if (!parsedProxy.ok || !parsedProxy.proxyUrl) {
    return;
  }

  app.whenReady().then(function() {
    applyProxyConfiguration(parsedProxy.proxyUrl);
    console.log("[RDPrep bootstrap] proxy applied from environment: " + parsedProxy.proxyUrl);
  }).catch(function(error) {
    logBootstrapError("environment proxy configuration failed", error);
  });
}

function applyProxyConfiguration(proxyUrl) {
  disableAxiosBuiltInProxy();
  setNodeHttpsTunnel(proxyUrl);
  setEnvironmentProxy(proxyUrl);
  activeProxyUrl = proxyUrl;
  setElectronSessionProxy(proxyUrl);
}

function parseProxyInput(proxyUrl) {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);

  if (normalizedProxyUrl === null) {
    return { ok: true, proxyUrl: null };
  }

  try {
    const parsedProxy = new URL(normalizedProxyUrl);
    return { ok: true, proxyUrl: parsedProxy.href };
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

function setEnvironmentProxy(proxyUrl) {
  PROXY_ENV_KEYS.forEach(function(environmentKey) {
    if (proxyUrl) {
      process.env[environmentKey] = proxyUrl;
    } else {
      delete process.env[environmentKey];
    }
  });
}

// axios 0.21.x cannot talk to an HTTP proxy for HTTPS targets: instead of a
// CONNECT tunnel it sends the request in absolute-form over plain HTTP, which
// proxies (gost included) reject with 400. Its built-in proxy handling — both
// explicit config and env-var pickup — must therefore stay disabled; HTTPS
// proxying happens at the socket layer in setNodeHttpsTunnel instead.
function disableAxiosBuiltInProxy() {
  let axios;

  try {
    axios = require("axios");
  } catch (_error) {
    return;
  }

  if (axios && axios.defaults) {
    axios.defaults.proxy = false;
  }
}

// Tunnels every https.Agent connection through the proxy with a real CONNECT
// handshake. Patching the prototype covers the app's own per-request
// new https.Agent({rejectUnauthorized:false}) instances as well as
// https.globalAgent, regardless of which HTTP client sits on top.
function setNodeHttpsTunnel(proxyUrl) {
  const https = require("https");
  const net = require("net");
  const agentPrototype = https.Agent.prototype;

  if (!agentPrototype[HTTPS_TUNNEL_ORIGINAL_SYMBOL]) {
    Object.defineProperty(agentPrototype, HTTPS_TUNNEL_ORIGINAL_SYMBOL, {
      value: agentPrototype.createConnection,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }

  const originalCreateConnection = agentPrototype[HTTPS_TUNNEL_ORIGINAL_SYMBOL];

  if (!proxyUrl) {
    agentPrototype.createConnection = originalCreateConnection;
    return;
  }

  const proxy = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port || 80);
  const proxyAuthHeader = proxy.username || proxy.password
    ? "Proxy-Authorization: Basic " +
      Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64") +
      "\\r\\n"
    : "";

  agentPrototype.createConnection = function rdprepTunneledCreateConnection(options, oncreate) {
    const agent = this;
    const connectionOptions = options || {};
    const targetHost = connectionOptions.host || connectionOptions.hostname || "localhost";
    const targetPort = Number(connectionOptions.port || 443);
    const targetAuthority = targetHost + ":" + targetPort;
    let settled = false;
    let connectResponse = "";

    const proxySocket = net.connect({ host: proxyHost, port: proxyPort });

    function failTunnel(error) {
      if (settled) {
        return;
      }
      settled = true;
      proxySocket.destroy();
      if (typeof oncreate === "function") {
        oncreate(error);
      }
    }

    proxySocket.on("error", failTunnel);
    proxySocket.setTimeout(30000, function() {
      failTunnel(new Error("proxy CONNECT to " + targetAuthority + " timed out"));
    });

    proxySocket.once("connect", function() {
      proxySocket.write(
        "CONNECT " + targetAuthority + " HTTP/1.1\\r\\n" +
        "Host: " + targetAuthority + "\\r\\n" +
        proxyAuthHeader +
        "\\r\\n"
      );
    });

    proxySocket.on("data", function onConnectData(chunk) {
      connectResponse += chunk.toString("latin1");

      if (connectResponse.indexOf("\\r\\n\\r\\n") === -1) {
        if (connectResponse.length > 16384) {
          failTunnel(new Error("proxy CONNECT response exceeded 16KB"));
        }
        return;
      }

      proxySocket.removeListener("data", onConnectData);

      const statusMatch = /^HTTP\\/1\\.[01] (\\d{3})/.exec(connectResponse);
      if (!statusMatch || statusMatch[1] !== "200") {
        failTunnel(new Error(
          "proxy CONNECT to " + targetAuthority + " failed: " + connectResponse.split("\\r\\n")[0]
        ));
        return;
      }

      if (settled) {
        return;
      }
      settled = true;
      proxySocket.setTimeout(0);
      proxySocket.removeListener("error", failTunnel);

      const secureOptions = Object.assign({}, connectionOptions, {
        socket: proxySocket,
        host: targetHost,
        servername: connectionOptions.servername || (net.isIP(targetHost) ? "" : targetHost)
      });
      delete secureOptions.path;

      try {
        const secureSocket = originalCreateConnection.call(agent, secureOptions);
        if (typeof oncreate === "function") {
          oncreate(null, secureSocket);
        }
      } catch (error) {
        proxySocket.destroy();
        if (typeof oncreate === "function") {
          oncreate(error);
        }
      }
    });
  };
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
