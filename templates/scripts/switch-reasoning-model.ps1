param(
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$aliases = @{
  "deepseek"       = "deepseek/deepseek-v4-pro"
  "deepseek-v4-pro" = "deepseek/deepseek-v4-pro"
  "direct"         = "deepseek/deepseek-v4-pro"
  "zen"            = "opencode/deepseek-v4-pro"
  "opencode"       = "opencode/deepseek-v4-pro"
  "big-pickle"     = "opencode/big-pickle"
  "pickle"         = "opencode/big-pickle"
  "bigpickle"      = "opencode/big-pickle"
  "nvidia"         = "nvidia/moonshotai/kimi-k3"
  "kimi"           = "nvidia/moonshotai/kimi-k3"
  "kimi-k3"        = "nvidia/moonshotai/kimi-k3"
  "openrouter"     = "openrouter/minimax/minimax-m3"
  "or"             = "openrouter/minimax/minimax-m3"
  "minimax-m3"     = "openrouter/minimax/minimax-m3"
  "m3"             = "openrouter/minimax/minimax-m3"
}

$targetModel = $Target
if ($aliases.ContainsKey($Target.ToLowerInvariant())) {
  $targetModel = $aliases[$Target.ToLowerInvariant()]
}
elseif (-not ($targetModel -match "^[a-zA-Z0-9._-]+/")) {
  $targetModel = "deepseek/$targetModel"
}

$reasoningModels = @(
  "deepseek/deepseek-v4-pro",
  "opencode/deepseek-v4-pro",
  "opencode/big-pickle",
  "nvidia/moonshotai/kimi-k3",
  "openrouter/minimax/minimax-m3"
)

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
