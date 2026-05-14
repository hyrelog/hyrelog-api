# HyreLog - Run Prisma Migrations for All Regions
# This script runs migrations against all 4 Postgres databases (US, EU, UK, AU)

param(
    [switch]$Reset = $false
)

$ErrorActionPreference = "Stop"

Write-Host "HyreLog - Multi-Region Migration Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
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
    Write-Host "Migrating $($region.Name) region..." -ForegroundColor Yellow
    Write-Host "  Database: $($region.DbName) on port $($region.Port)" -ForegroundColor Gray
    
    $databaseUrl = "postgresql://hyrelog:hyrelog@localhost:$($region.Port)/$($region.DbName)"
    
    # prisma.config.ts prefers DATABASE_URL_US over DATABASE_URL — use explicit migrate URL
    $env:PRISMA_MIGRATE_DATASOURCE_URL = $databaseUrl
    
    try {
        Push-Location $apiPath
        
        if ($Reset) {
            Write-Host "  Resetting database (WARNING: This will delete all data!)" -ForegroundColor Red
            npx prisma migrate reset --skip-seed --force
        } else {
            # Check if migrations directory exists and has migrations
            $migrationsPath = Join-Path (Join-Path $apiPath "prisma") "migrations"
            if (-not (Test-Path $migrationsPath) -or (Get-ChildItem $migrationsPath -Directory -ErrorAction SilentlyContinue).Count -eq 0) {
                # Create initial migration
                Write-Host "  Creating initial migration..." -ForegroundColor Gray
                npx prisma migrate dev --name init --create-only
            }
            # Deploy migrations
            Write-Host "  Deploying migrations..." -ForegroundColor Gray
            npx prisma migrate deploy
        }
        
        Write-Host "  Success: $($region.Name) region migrated" -ForegroundColor Green
    }
    catch {
        Write-Host "  Failed to migrate $($region.Name) region" -ForegroundColor Red
        Write-Host "    Error: $_" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    finally {
        Pop-Location
        Remove-Item Env:\PRISMA_MIGRATE_DATASOURCE_URL -ErrorAction SilentlyContinue
    }
    
    Write-Host ""
}

Write-Host "All regions migrated successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Generate Prisma Client: npm run prisma:generate" -ForegroundColor Gray
Write-Host "  2. Start the API: npm run dev" -ForegroundColor Gray
