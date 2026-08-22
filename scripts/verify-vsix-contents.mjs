const requiredPaths = [
  "dist/extension/extension/mcp/mcpClientManager.js",
  "node_modules/@modelcontextprotocol/client/package.json",
  "node_modules/@modelcontextprotocol/client/dist/index.cjs",
  "node_modules/@modelcontextprotocol/client/dist/validators/ajv.cjs",
  "node_modules/@modelcontextprotocol/core/package.json",
  "node_modules/eventsource/package.json",
  "node_modules/eventsource-parser/package.json",
  "node_modules/jose/package.json",
  "node_modules/pkce-challenge/package.json",
  "node_modules/zod/package.json",
  "node_modules/yaml/package.json",
  "node_modules/yaml/dist/index.js"
];

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const packagedPaths = new Set(
  Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/u)
    .map((path) => path.trim().replaceAll("\\", "/"))
    .filter(Boolean)
);
const missingPaths = requiredPaths.filter((path) => !packagedPaths.has(path));

if (missingPaths.length > 0) {
  console.error("VSIXに必須の拡張機能ランタイムファイルが含まれていません:");
  for (const path of missingPaths) {
    console.error(`- ${path}`);
  }
  process.exitCode = 1;
} else {
  console.log(`VSIXの必須ランタイムファイルを確認しました (${requiredPaths.length}件)。`);
}
