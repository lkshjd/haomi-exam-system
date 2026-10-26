param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$message) {
  Write-Host "[错误] $message" -ForegroundColor Red
  exit 1
}

try {
  $nodeVersion = node -v
} catch {
  Fail '未找到 Node.js，请安装 Node.js 22 LTS：https://nodejs.org/'
}
Write-Host "Node.js $nodeVersion" -ForegroundColor Green

if (-not (Test-Path 'node_modules')) {
  Write-Host '首次运行：安装依赖，可能需要几分钟…'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail 'npm install 失败' }
}

if (-not (Test-Path 'prisma\dev.db')) {
  Write-Host '初始化本地数据库…'
  npx prisma db push --skip-generate
  if ($LASTEXITCODE -ne 0) { Fail '数据库初始化失败' }
}

if (-not (Test-Path 'storage')) {
  New-Item -ItemType Directory -Path 'storage' | Out-Null
}

$workerOut = Join-Path $PSScriptRoot 'storage\worker.log'
$workerErr = Join-Path $PSScriptRoot 'storage\worker.err.log'
$worker = Start-Process -FilePath 'node' `
  -ArgumentList 'node_modules/tsx/dist/cli.mjs', '--env-file=.env', 'src/worker/grader.ts' `
  -PassThru -NoNewWindow -RedirectStandardOutput $workerOut -RedirectStandardError $workerErr

Write-Host '批改 worker 已启动（日志：storage\worker.log）' -ForegroundColor Green

$browserJob = $null
if (-not $NoBrowser) {
  $browserJob = Start-Job -ScriptBlock {
    Start-Sleep -Seconds 5
    Start-Process 'http://127.0.0.1:3000'
  }
}

try {
  Write-Host '启动本地做题系统：http://127.0.0.1:3000'
  Write-Host '按 Ctrl+C 停止。'
  npm run dev
} finally {
  if ($browserJob) {
    Stop-Job $browserJob -ErrorAction SilentlyContinue
    Remove-Job $browserJob -Force -ErrorAction SilentlyContinue
  }
  if ($worker -and -not $worker.HasExited) {
    Write-Host '停止批改 worker…'
    Stop-Process -Id $worker.Id -Force
  }
}
