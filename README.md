# Mentor Code

Mentor Code is an open-source AI coding mentor for VS Code. It helps developers plan changes, request staged guidance, review diffs, and inspect privacy risks before sending workspace context to an AI service.

## Features

- Implementation planning before code changes
- Staged hints that preserve the developer's reasoning process
- Diff review for requirements, exceptions, security, and maintainability
- Send-time previews with file exclusions and masking
- Local privacy checks for credentials, personal data, and confidential content
- Self-hosted app server support

## Repository layout

- `src/extension/` — VS Code extension
- `src/webview/` — extension interface
- `src/server/` — self-hosted app server
- `src/domain/` — shared domain logic and privacy guards
- `tests/` — automated tests

## Requirements

- Node.js 22 or later
- npm 10 or later
- VS Code 1.92 or later for the extension

## Development

```powershell
npm ci
npm run check
npm test
npm run build
```

## Self-hosting the app server

Build the project, create a local bootstrap file, and start the server with a generated token:

```powershell
npm ci
npm run build
New-Item -ItemType Directory -Force .mentor-code | Out-Null
'{"adminId":"admin","password":"use-a-unique-password-of-at-least-12-characters"}' | Set-Content -Encoding utf8 .mentor-code/admin-bootstrap.json
$env:MENTOR_SERVER_TOKEN = [guid]::NewGuid().ToString("N")
$env:MENTOR_ADMIN_BOOTSTRAP_FILE = (Resolve-Path .mentor-code/admin-bootstrap.json)
npm run start:server
```

After the first administrator login, stop the server, delete the bootstrap file, clear `MENTOR_ADMIN_BOOTSTRAP_FILE`, and start the server again. Keep `.mentor-code`, environment variables, logs, backups, and generated packages outside any public directory.

Configure the extension with the URL of the app server and a user token issued by its administrator. External model credentials are supplied through environment variables; they are never committed to this repository.

The optional local Bonsai runtime is described by `vendor/bonsai/manifest.json`. Its model file is intentionally not stored in Git because of its size and must be obtained separately when local inference is enabled.

## Privacy and security

Review the send-time preview before every external request. Self-hosters are responsible for protecting API keys, admin credentials, user tokens, database files, logs, backups, and reverse-proxy configuration. Do not expose the app server directly to the public internet without appropriate authentication, TLS termination, and network controls.

## License

Mentor Code is released under the MIT License. See `LICENSE`.
