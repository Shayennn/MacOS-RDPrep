const fs = require("fs");
const filePath = process.argv[2];
let source = fs.readFileSync(filePath, "utf8");

// 1. Electron 22 renderer compatibility
source = source.replace(
  /nodeIntegration:\s*!0,(?!\s*\n\s*contextIsolation:)/g,
  "nodeIntegration: !0,\n\t\t\tcontextIsolation: !1,\n\t\t\tsandbox: !1,"
);

// 2. Enable devtools in production (hidden, open via Alt+I)
source = source.replace("devTools: !!serve", "devTools: true");

// 3. Forward main process console to renderer devtools
source = source.replace(
  "function createWindow() {",
  "function createWindow() {\n" +
  "\tconst origLog = console.log;\n" +
  "\tconst origErr = console.error;\n" +
  "\tconsole.log = function() {\n" +
  "\t\torigLog.apply(console, arguments);\n" +
  '\t\ttry { if (win && win.webContents) win.webContents.executeJavaScript("console.log(\\"[main]\\"," + JSON.stringify(Array.from(arguments).join(" ")) + ")"); } catch(e) {}\n' +
  "\t};\n" +
  "\tconsole.error = function() {\n" +
  "\t\torigErr.apply(console, arguments);\n" +
  '\t\ttry { if (win && win.webContents) win.webContents.executeJavaScript("console.error(\\"[main]\\"," + JSON.stringify(Array.from(arguments).join(" ")) + ")"); } catch(e) {}\n' +
  "\t};"
);

// 4. Inject window.setProxy() into renderer on did-finish-load
// Use \x27 for single quotes to avoid escaping issues
var injectJS = "window.setProxy=function(u){require(\\x27electron\\x27).ipcRenderer.sendSync(\\x27set-proxy\\x27,u);console.log(\\x27[proxy]\\x27,u||\\x27cleared\\x27)};console.log(\\x27Proxy helpers: setProxy(url) | setProxy(null) to clear\\x27)";
source = source.replace(
  'win.webContents.send("redirectURL", redirectURL), redirectURL = ""',
  'win.webContents.send("redirectURL", redirectURL), redirectURL = ""; win.webContents.executeJavaScript("' + injectJS + '")'
);

// 5. Add IPC handler for set-proxy
// Sets env vars (for request lib) + axios.defaults.proxy + Electron session
var ph = "\n";
ph += "\tvar _axios = require('axios');\n";
ph += "\tvar _urlp = require('url');\n";
ph += "\telectron_1.ipcMain.on('set-proxy', function(evt, proxyUrl) {\n";
ph += "\t\tif (!proxyUrl) {\n";
ph += "\t\t\tdelete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;\n";
ph += "\t\t\tdelete process.env.http_proxy; delete process.env.https_proxy;\n";
ph += "\t\t\ttry { _axios.defaults.proxy = false; } catch(e) {}\n";
ph += "\t\t\ttry { win.webContents.session.setProxy({ proxyRules: '' }); } catch(e) {}\n";
ph += "\t\t\tconsole.log('[proxy] cleared');\n";
ph += "\t\t} else {\n";
ph += "\t\t\tprocess.env.HTTP_PROXY = proxyUrl;\n";
ph += "\t\t\tprocess.env.HTTPS_PROXY = proxyUrl;\n";
ph += "\t\t\tprocess.env.http_proxy = proxyUrl;\n";
ph += "\t\t\tprocess.env.https_proxy = proxyUrl;\n";
ph += "\t\t\ttry {\n";
ph += "\t\t\t\tvar pu = _urlp.parse(proxyUrl);\n";
ph += "\t\t\t\t_axios.defaults.proxy = { host: pu.hostname, port: parseInt(pu.port), protocol: pu.protocol.replace(':', '') };\n";
ph += "\t\t\t} catch(e) { console.error('[proxy] axios error:', e); }\n";
ph += "\t\t\ttry { win.webContents.session.setProxy({ proxyRules: proxyUrl }); } catch(e) {}\n";
ph += "\t\t\tconsole.log('[proxy] set to:', proxyUrl);\n";
ph += "\t\t}\n";
ph += "\t\tevt.returnValue = proxyUrl;\n";
ph += "\t});\n";

source = source.replace("z_service_1.ZService.initZ()", "z_service_1.ZService.initZ()" + ph);

// Verify syntax
try {
  new Function(source);
  console.log("All patches applied OK");
} catch(e) {
  console.error("SYNTAX ERROR:", e.message);
  process.exit(1);
}

fs.writeFileSync(filePath, source);
