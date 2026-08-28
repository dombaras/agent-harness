param(
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$aliases = @{
  "deepseek"        = "opencode/deepseek-v4-pro"
  "deepseek-v4-pro" = "opencode/deepseek-v4-pro"
  "pro"             = "opencode/deepseek-v4-pro"
  "big-pickle"      = "opencode/big-pickle"
  "pickle"          = "opencode/big-pickle"
  "bigpickle"       = "opencode/big-pickle"
}

$targetModel = $Target
if ($aliases.ContainsKey($Target.ToLowerInvariant())) {
  $targetModel = $aliases[$Target.ToLowerInvariant()]
}
elseif (-not $targetModel.StartsWith("opencode/")) {
  $targetModel = "opencode/$targetModel"
}

$reasoningModels = @("opencode/deepseek-v4-pro", "opencode/big-pickle")

$files = @(
  "opencode.json",
  ".opencode/agents/planner.md",
  ".opencode/agents/system-architect.md",
  ".opencode/agents/security-engineer.md",
  ".opencode/agents/diagnostics-expert.md",
  ".opencode/agents/product-manager.md",
  ".opencode/agents/qa-architect.md"
)

$changed = @()
foreach ($rel in $files) {
  $path = Join-Path $root $rel
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Warning "missing: $rel"
    continue
  }
  $content = Get-Content -LiteralPath $path -Raw
  $new = $content
  foreach ($m in $reasoningModels) {
    $new = $new -replace [regex]::Escape($m), $targetModel
  }
  if ($new -ne $content) {
    Set-Content -LiteralPath $path -Value $new -NoNewline
    $changed += $rel
  }
}

Write-Output ("Switched reasoning-tier model -> {0}" -f $targetModel)
if ($changed.Count -gt 0) {
  Write-Output "Updated:"
  $changed | ForEach-Object { Write-Output "  - $_" }
}
else {
  Write-Output "No files changed (already set)."
}
Write-Output "Restart opencode for the change to take effect."
