param(
  [switch]$UsePm2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

if ($UsePm2) {
  npm run local:env:check
  npm run build
  npm run pm2:start
} else {
  npm run local:prod
}
