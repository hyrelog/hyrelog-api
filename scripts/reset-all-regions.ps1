# HyreLog - Reset All Region Databases to Default (Zero Data)
# Clears all companies, workspaces, events, webhooks, etc. and re-seeds only plans.
# Use this before E2E testing to get a clean slate across US, EU, UK, AU.
#
# Prerequisites:
#   - Docker Compose Postgres instances running (ports 54321-54324) or your .env DATABASE_URL_* set
#   - Migrations already applied to all regions (run npm run prisma:migrate:all first)
#
# Usage: from repo root
#   powershell -ExecutionPolicy Bypass -File ./scripts/reset-all-regions.ps1
#   or: npm run seed:reset:all

param(
    [string]$DbHost = "localhost",
    [string]$DbUser = "hyrelog",
    [string]$DbPass = "hyrelog"
)

$ErrorActionPreference = "Stop"

Write-Host "HyreLog - Reset All Regions to Default (Zero Data)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

$regions = @(
    @{ Name = "US"; Port = "54321"; DbName = "hyrelog_us" },
    @{ Name = "EU"; Port = "54322"; DbName = "hyrelog_eu" },
    @{ Name = "UK"; Port = "54323"; DbName = "hyrelog_uk" },
    @{ Name = "AU"; Port = "54324"; DbName = "hyrelog_au" }
)

$rootPath = Split-Path -Parent $PSScriptRoot
$apiPath = Join-Path (Join-Path $rootPath "services") "api"

foreach ($region in $regions) {
    Write-Host "Resetting $($region.Name) region..." -ForegroundColor Yellow
    Write-Host "  Database: $($region.DbName) on $DbHost`:$($region.Port)" -ForegroundColor Gray

    $databaseUrl = "postgresql://${DbUser}:${DbPass}@${DbHost}:$($region.Port)/$($region.DbName)"
    $env:DATABASE_URL = $databaseUrl
    $env:SEED_RESET_REGION_LABEL = $region.Name

    try {
        Push-Location $apiPath
        npx tsx prisma/seed-reset.ts
        Write-Host "  Success: $($region.Name) reset" -ForegroundColor Green
    }
    catch {
        Write-Host "  Failed to reset $($region.Name)" -ForegroundColor Red
        Write-Host "    Error: $_" -ForegroundColor Red
        Pop-Location
        Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SEED_RESET_REGION_LABEL -ErrorAction SilentlyContinue
        exit 1
    }
    finally {
        Pop-Location
        Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SEED_RESET_REGION_LABEL -ErrorAction SilentlyContinue
    }

    Write-Host ""
}

Write-Host "All regions reset successfully. No companies or API keys remain; plans only." -ForegroundColor Green
Write-Host ""
