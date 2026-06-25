# Rebuild the worker image and push it to ECR.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File redeploy.ps1
# After it finishes, the next run (scheduled or manual) uses the new code.

$ErrorActionPreference = "Stop"
$REGION   = "eu-central-1"
$REGISTRY = "114930026703.dkr.ecr.eu-central-1.amazonaws.com"
$IMAGE    = "$REGISTRY/digiteka-maxmind-worker:latest"

Write-Host "1/3  Building image..." -ForegroundColor Cyan
docker build -t $IMAGE $PSScriptRoot

Write-Host "2/3  Logging in to ECR..." -ForegroundColor Cyan
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY

Write-Host "3/3  Pushing image..." -ForegroundColor Cyan
docker push $IMAGE

Write-Host ""
Write-Host "Done. New image is in ECR." -ForegroundColor Green
Write-Host "It will be used on the next scheduled run (Tue/Fri 10:00 UTC)." -ForegroundColor Green
Write-Host "To apply it right now, run a one-off task:" -ForegroundColor Green
Write-Host "  aws ecs run-task --cluster digiteka-maxmind-worker --task-definition digiteka-maxmind-worker --launch-type FARGATE --count 1 --network-configuration file://deploy/network-config.json --region $REGION" -ForegroundColor DarkGray
