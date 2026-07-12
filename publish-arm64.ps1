param(
  [string]$ImageName = 'bigbluewhalebutton/servo-control-webapp',
  [string]$Tag = 'arm-latest',
  [string]$Platform = 'linux/arm64'
)

$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

Write-Host "Building and publishing ${ImageName}:${Tag} for $Platform"

docker buildx build `
  --platform $Platform `
  -t "${ImageName}:${Tag}" `
  --push `
  .