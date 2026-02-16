# Mark renamed migrations as applied (use when EU/UK/AU already had them under old names).
# Run from repo root: powershell -ExecutionPolicy Bypass -File ./scripts/migrate-resolve-renamed.ps1

$ErrorActionPreference = "Stop"
$rootPath = Split-Path -Parent $PSScriptRoot
$apiPath = Join-Path (Join-Path $rootPath "services") "api"

$regions = @(
  @{ Name = "EU"; Port = "54322"; DbName = "hyrelog_eu" },
  @{ Name = "UK"; Port = "54323"; DbName = "hyrelog_uk" },
  @{ Name = "AU"; Port = "54324"; DbName = "hyrelog_au" }
)

# Only resolve migrations that already ran under an old name (same SQL, different folder name).
$migrationsToResolve = @(
  "20251230000000_add_plan_model",
  "20251231000000_add_exports_and_archive_updates",
  "20260101000000_add_dashboard_and_glacier_restore"
)

Write-Host "Resolve renamed migrations (mark as applied) for EU, UK, AU..." -ForegroundColor Cyan
foreach ($r in $regions) {
  $env:DATABASE_URL = "postgresql://hyrelog:hyrelog@localhost:$($r.Port)/$($r.DbName)"
  Write-Host "  $($r.Name) ($($r.DbName))..." -ForegroundColor Yellow
  Push-Location $apiPath
  try {
    foreach ($m in $migrationsToResolve) {
      # Use cmd so Prisma's stderr (e.g. "Loaded Prisma config...") doesn't trigger PowerShell errors
      cmd /c "npx prisma migrate resolve --applied $m 2>nul"
      if ($LASTEXITCODE -eq 0) { Write-Host "    $m - marked applied" -ForegroundColor Green }
    }
  } finally {
    Pop-Location
  }
}
Write-Host "Done. Run npm run prisma:migrate:all to apply any remaining migrations." -ForegroundColor Cyan
