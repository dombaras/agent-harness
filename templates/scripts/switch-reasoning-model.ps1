param(
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$aliases = @{
  "go"                = "opencode-go/deepseek-v4.1-flash"
  "go-flash"          = "opencode-go/deepseek-v4.1-flash"
  "go-deepseek"       = "opencode-go/deepseek-v4.1-flash"
  "go-pro"            = "opencode-go/deepseek-v4-pro"
  "deepseek"          = "deepseek/deepseek-flash"
  "flash"             = "deepseek/deepseek-flash"
  "deepseek-flash"    = "deepseek/deepseek-flash"
  "direct"            = "deepseek/deepseek-flash"
  "deepseek-pro"      = "deepseek/deepseek-v4-pro"
  "deepseek-v4-pro"   = "deepseek/deepseek-v4-pro"
  "pro"               = "deepseek/deepseek-v4-pro"
  "nvidia"            = "nvidia/moonshotai/kimi-k3"
  "kimi"              = "nvidia/moonshotai/kimi-k3"
  "kimi-k3"           = "nvidia/moonshotai/kimi-k3"
  "nemotron"          = "nvidia/nemotron-3-ultra-550b-a55b:free"
  "nemotron-ultra"    = "nvidia/nemotron-3-ultra-550b-a55b:free"
  "openrouter"        = "openrouter/minimax/minimax-m3"
  "or"                = "openrouter/minimax/minimax-m3"
  "minimax-m3"        = "openrouter/minimax/minimax-m3"
  "m3"                = "openrouter/minimax/minimax-m3"
}

$targetModel = $Target
if ($aliases.ContainsKey($Target.ToLowerInvariant())) {
  $targetModel = $aliases[$Target.ToLowerInvariant()]
}
elseif (-not ($targetModel -match "^[a-zA-Z0-9._-]+/")) {
  $targetModel = "deepseek/$targetModel"
}

# The replace list is derived from the alias map so any model the script can
# switch TO is also a model it can switch FROM. Without this, a value the user
# hand-set (or set via a previous alias) but that is not in the find list is
# invisible to the regex and the script silently reports "already set".
$reasoningModels = @($aliases.Values | Sort-Object -Unique)

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
$skipped = @()
foreach ($rel in $files) {
  $path = Join-Path $root $rel
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Warning "missing: $rel"
    continue
  }
  $content = Get-Content -LiteralPath $path -Raw
  $new = $content
  $findHits = $false
  foreach ($m in $reasoningModels) {
    if ($m -eq $targetModel) { continue }
    if ($new -match [regex]::Escape($m)) { $findHits = $true }
    $new = $new -replace [regex]::Escape($m), $targetModel
  }
  if ($new -ne $content) {
    Set-Content -LiteralPath $path -Value $new -NoNewline
    $changed += $rel
  }
  elseif (-not $findHits -and $content -notmatch ([regex]::Escape($targetModel))) {
    # content != target, but the regex never matched — the current value is a
    # model id the script doesn't know how to replace. Surface it instead of
    # printing a misleading "already set".
    $current = ($content | Select-String -Pattern 'model:\s*"?([A-Za-z0-9._:\-/]+)"?' -AllMatches).Matches |
      ForEach-Object { $_.Groups[1].Value } |
      Where-Object { $_ -ne $targetModel -and $_ -notin $reasoningModels } |
      Select-Object -First 1
    $skipped += "$rel (current value `"$current`" not in replace list; edit by hand or add an alias)"
  }
}

Write-Output ("Switched reasoning-tier model -> {0}" -f $targetModel)
if ($changed.Count -gt 0) {
  Write-Output "Updated:"
  $changed | ForEach-Object { Write-Output "  - $_" }
}
if ($skipped.Count -gt 0) {
  Write-Warning "Skipped (current value not in replace list):"
  $skipped | ForEach-Object { Write-Warning "  - $_" }
  Write-Warning "Add an alias to scripts/switch-reasoning-model.ps1 (or edit the file by hand)."
}
if ($changed.Count -eq 0 -and $skipped.Count -eq 0) {
  Write-Output "No files changed (already set)."
}
Write-Output "Restart opencode for the change to take effect."
