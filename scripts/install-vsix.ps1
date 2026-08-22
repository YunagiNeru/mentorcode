[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$VsixPath = ""
)

$ErrorActionPreference = "Stop"

function Invoke-CheckedStep {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Name"
  & $Action
}

function Get-CodeCommand {
  $stable = Get-Command code -ErrorAction SilentlyContinue
  if ($stable) {
    return $stable.Source
  }

  $insiders = Get-Command code-insiders -ErrorAction SilentlyContinue
  if ($insiders) {
    return $insiders.Source
  }

  throw "VS Code CLI command was not found. Enable 'Shell Command: Install code command in PATH' from VS Code, then retry."
}

$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $workspaceRoot

$extensionId = "local.mentor-code"

if (-not $SkipBuild) {
  Invoke-CheckedStep "Type check" {
    npm run check
  }

  Invoke-CheckedStep "Unit tests" {
    npm test
  }

  Invoke-CheckedStep "Build extension, server, and webview" {
    npm run build
  }
}

Invoke-CheckedStep "Package VSIX" {
  npm run package:vsix
}

if ([string]::IsNullOrWhiteSpace($VsixPath)) {
  $latestVsix = Get-ChildItem -LiteralPath $workspaceRoot -Filter "mentor-code-*.vsix" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $latestVsix) {
    throw "VSIX file was not generated."
  }

  $VsixPath = $latestVsix.FullName
} else {
  $VsixPath = (Resolve-Path $VsixPath).Path
}

$codeCommand = Get-CodeCommand

Invoke-CheckedStep "Uninstall old VS Code extension if present" {
  & $codeCommand --uninstall-extension $extensionId
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Old extension was not installed or could not be removed. Continuing with forced install."
  }
}

Invoke-CheckedStep "Install current VSIX with force" {
  & $codeCommand --install-extension $VsixPath --force
  if ($LASTEXITCODE -ne 0) {
    throw "VSIX install failed."
  }
}

Invoke-CheckedStep "Confirm installed extension" {
  $installed = & $codeCommand --list-extensions --show-versions | Select-String -Pattern "^local\.mentor-code@"
  if (-not $installed) {
    throw "Installed extension was not found after VSIX install."
  }

  $installed
}

Write-Host ""
Write-Host "VSIX update completed: $VsixPath"
Write-Host "Reload VS Code or restart Extension Development Host before opening Mentor Code."
