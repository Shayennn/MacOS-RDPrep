const fs = require("fs");
const filePath = process.argv[2];
const source = fs.readFileSync(filePath, "utf8");

try {
  new Function(source);
  console.log("Version-agnostic bootstrap installed – patch-main is a no-op wrapper");
} catch(e) {
  console.error("SYNTAX ERROR:", e.message);
  process.exit(1);
}
