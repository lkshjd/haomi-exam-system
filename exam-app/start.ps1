$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path 'node_modules')) {
  Write-Host '首次运行：安装依赖…'
  npm install --no-audit --no-fund
}

if (-not (Test-Path 'prisma\dev.db')) {
  Write-Host '初始化本地数据库…'
  npx prisma db push --skip-generate
}

if (-not (Test-Path 'storage')) {
  New-Item -ItemType Directory -Path 'storage' | Out-Null
}

$workerOut = Join-Path $PSScriptRoot 'storage\worker.log'
$workerErr = Join-Path $PSScriptRoot 'storage\worker.err.log'
$worker = Start-Process -FilePath 'node' `
  -ArgumentList 'node_modules/tsx/dist/cli.mjs', '--env-file=.env', 'src/worker/grader.ts' `
  -PassThru -NoNewWindow -RedirectStandardOutput $workerOut -RedirectStandardError $workerErr

Write-Host "批改 worker 已启动（日志：storage\worker.log）"

try {
  Write-Host '启动本地做题系统：http://127.0.0.1:3000'
  Start-Process 'http://127.0.0.1:3000'
  npm run dev
} finally {
  if ($worker -and -not $worker.HasExited) {
    Write-Host '停止批改 worker…'
    Stop-Process -Id $worker.Id -Force
  }
}
