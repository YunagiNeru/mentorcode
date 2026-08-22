import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const artifactNames = [
  `mentor-code-${packageJson.version}.vsix`,
  `mentor-code-app-server-${packageJson.version}.tar.gz`
];
const artifactsDirectory = join(root, "artifacts");

removeStaleReleaseMetadata();
assertCleanTrackedTree();
assertSafePackageContents();

const artifactEntries = artifactNames.map((fileName) => artifactEntry(fileName));
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  gitCommit: command("git", ["rev-parse", "HEAD"]),
  extension: {
    version: packageJson.version,
    mentorClientVersion: packageJson.mentorClientVersion
  },
  build: {
    node: process.version,
    npm: npmVersion(),
    platform: process.platform,
    arch: process.arch
  },
  artifacts: artifactEntries
};

mkdirSync(artifactsDirectory, { recursive: true });
writeAtomic(
  join(artifactsDirectory, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
for (const artifact of artifactEntries) {
  writeAtomic(
    join(artifactsDirectory, `${artifact.fileName}.sha256`),
    `${artifact.sha256}  ${artifact.fileName}\n`
  );
}
console.log(JSON.stringify({
  ok: true,
  artifacts: manifest.artifacts,
  gitCommit: manifest.gitCommit,
  manifest: "artifacts/release-manifest.json"
}));

function assertCleanTrackedTree() {
  const status = command("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (status.length > 0) {
    throw new Error("Tracked files are modified. Commit the release candidate before creating its manifest.");
  }
}

function removeStaleReleaseMetadata() {
  const metadataNames = [
    "release-manifest.json",
    ...artifactNames.map((fileName) => `${fileName}.sha256`)
  ];
  for (const fileName of metadataNames) {
    const path = join(artifactsDirectory, fileName);
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  }
}

function assertSafePackageContents() {
  const vsce = join(root, "node_modules", "@vscode", "vsce", "vsce");
  const files = command(process.execPath, [vsce, "ls"]).split(/\r?\n/).filter(Boolean);
  const forbidden = files.filter((file) => {
    const normalized = file.replaceAll("\\", "/").toLowerCase();
    const name = normalized.split("/").at(-1) ?? normalized;
    return normalized.startsWith("docs/") ||
      normalized.startsWith(".github/") ||
      name === ".env" ||
      name.startsWith(".env.") ||
      [".key", ".pem", ".p12", ".pfx", ".zip"].some((suffix) => name.endsWith(suffix));
  });
  if (forbidden.length > 0) {
    throw new Error(`Forbidden files are included in the VSIX: ${forbidden.join(", ")}`);
  }
  assertNoCredentialMaterial(files);
}

function assertNoCredentialMaterial(files) {
  const credentialPatterns = [
    /AIza[0-9A-Za-z_-]{30,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  ];
  const unsafeFiles = files.filter((file) => {
    const content = readFileSync(join(root, file));
    if (!content.includes("AIza") && !content.includes("PRIVATE KEY-----")) {
      return false;
    }
    const text = content.toString("utf8");
    return credentialPatterns.some((pattern) => pattern.test(text));
  });
  if (unsafeFiles.length > 0) {
    throw new Error(`Credential-shaped material is included in the VSIX: ${unsafeFiles.join(", ")}`);
  }
}

function artifactEntry(fileName) {
  const path = join(root, fileName);
  const content = readFileSync(path);
  return {
    fileName,
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

function writeAtomic(path, content) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function command(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result.stdout.trim();
}

function npmVersion() {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("npm_execpath is missing. Run this script through npm run release:manifest.");
  }
  return command(process.execPath, [npmExecPath, "--version"]);
}
