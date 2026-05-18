# Sync hyrelog-prod/DATABASE_URL after dashboard RDS rotation and redeploy ECS services.
# Run from hyrelog-api repo root in PowerShell (AWS CLI authenticated).
param(
  [string]$PrimaryRegion = 'ap-southeast-2',
  [string]$ProjectPrefix = 'hyrelog-prod',
  [string]$EcsCluster = 'hyrelog-prod-ecs',
  [string[]]$EcsServices = @('hyrelog-api', 'hyrelog-worker', 'hyrelog-dashboard'),
  [string]$DashboardRdsSecretArn = 'arn:aws:secretsmanager:ap-southeast-2:163436765242:secret:rds!db-8790c16b-e0de-4e58-b2d6-200c1221aa86-6PHmH7',
  [string]$DashboardDbHost = 'hyrelog-prod-dashboard.c9umosqssoce.ap-southeast-2.rds.amazonaws.com',
  [string]$DashboardDbPort = '5432',
  [string]$DashboardDbName = 'hyrelog_dashboard',
  [switch]$SkipRedeploy
)

$ErrorActionPreference = 'Stop'

Write-Host "==> Building dashboard DATABASE_URL from RDS secret..."
$json = aws secretsmanager get-secret-value --secret-id $DashboardRdsSecretArn --region $PrimaryRegion --query SecretString --output text | ConvertFrom-Json
$user = [uri]::EscapeDataString($json.username)
$pass = [uri]::EscapeDataString($json.password)
$url = "postgresql://${user}:${pass}@${DashboardDbHost}:${DashboardDbPort}/${DashboardDbName}?sslmode=require"

aws secretsmanager update-secret --secret-id "$ProjectPrefix/DATABASE_URL" --secret-string $url --region $PrimaryRegion | Out-Null
Write-Host "Updated $ProjectPrefix/DATABASE_URL"

if (-not $SkipRedeploy) {
  foreach ($svc in $EcsServices) {
    aws ecs update-service --region $PrimaryRegion --cluster $EcsCluster --service $svc --force-new-deployment | Out-Null
    Write-Host "Redeploy triggered: $svc"
  }
  Write-Host "Waiting for services-stable..."
  aws ecs wait services-stable --region $PrimaryRegion --cluster $EcsCluster --services $EcsServices
  Write-Host "Done."
}
