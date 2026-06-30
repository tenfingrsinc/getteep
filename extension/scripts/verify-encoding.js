const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const roots = ["src", "public"];
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".ts", ".tsx"]);
const badSequences = ["\u00c2", "\u00c3", "\u00e2\u20ac", "\ufffd"];
const failures = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;

    const content = fs.readFileSync(fullPath, "utf8");
    content.split(/\r?\n/).forEach((line, index) => {
      if (badSequences.some((sequence) => line.includes(sequence))) {
        failures.push(`${path.relative(extensionRoot, fullPath)}:${index + 1}`);
      }
    });
  }
}

roots.forEach((root) => walk(path.join(extensionRoot, root)));

if (failures.length) {
  console.error("Common mojibake sequences were found:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Extension source encoding scan passed.");
