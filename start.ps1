# ============================================================
#  保持沟通就没人爆炸 - 启动脚本 (Windows / PowerShell)
#
#    .\start.ps1                        默认端口 3210, 前台运行, 自动开浏览器
#    .\start.ps1 -Port 8080             换端口
#    .\start.ps1 -NoBrowser             不自动打开浏览器
#    .\start.ps1 -AdminToken mytoken    固定管理入口令牌 (默认读环境变量 BOMB_ADMIN_TOKEN)
#    .\start.ps1 -Test                  测试模式 (会开放测试后门, 正常玩不要加)
#    .\start.ps1 -Detached              后台运行: 立刻返回, 日志写到 server.log
#
#  前台模式: Ctrl+C 停止.
#  后台模式: 在自己的窗口/桌面里运行最可靠; 要停就跑 .\stop.ps1 -Port 3210
# ============================================================
[CmdletBinding()]
param(
  [int]$Port = 3210,
  [string]$AdminToken = $env:BOMB_ADMIN_TOKEN,
  [switch]$Test,
  [switch]$NoBrowser,
  [switch]$Detached
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $root 'server/server.js'
$url = "http://localhost:$Port"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[bomb] 没有找到 node, 请先安装 Node.js 18+ : https://nodejs.org/' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $entry)) {
  Write-Host "[bomb] 找不到 $entry" -ForegroundColor Red
  exit 1
}

# 用 node 自己探测端口 (node 反正必须有, 而且不受 Windows 代理设置影响)
function Test-Up {
  & node -e "fetch('http://127.0.0.1:' + process.argv[1] + '/api/rooms').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))" "$Port" 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Wait-Up([int]$Seconds) {
  for ($i = 0; $i -lt ($Seconds * 4); $i++) {
    if (Test-Up) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Get-LanIp {
  try {
    $ip = (& node -e "const os=require('os');const n=os.networkInterfaces();for(const k of Object.keys(n))for(const a of n[k])if(a.family==='IPv4'&&!a.internal){console.log(a.address);process.exit(0)}" 2>$null | Select-Object -First 1)
    if ($ip) { return $ip.Trim() }
  } catch { }
  return $null
}

function Show-Addresses {
  Write-Host "[bomb]   本机:     $url"
  $lan = Get-LanIp
  if ($lan) { Write-Host "[bomb]   局域网:   http://${lan}:$Port" }
  $log = Join-Path $root 'server.log'
  $token = $AdminToken
  if (-not $token -and (Test-Path $log)) {
    $m = Select-String -Path $log -Pattern '/admin\?token=([A-Za-z0-9_\-]+)' | Select-Object -First 1
    if ($m) { $token = $m.Matches[0].Groups[1].Value }
  }
  if ($token) { Write-Host "[bomb]   管理入口: $url/admin?token=$token" }
}

# 端口上已经有本游戏在跑了? 不重复启动, 直接把地址给你.
if (Test-Up) {
  Write-Host "[bomb] 端口 $Port 上已经有一个服务在跑了, 直接用就行." -ForegroundColor Yellow
  Show-Addresses
  if (-not $NoBrowser) { Start-Process $url }
  exit 0
}

$nodeArgs = @($entry, "$Port")
if ($Test) { $nodeArgs += '--test' }
if ($AdminToken) { $nodeArgs += "--admin-token=$AdminToken" }

# ---------------------------------------------------------- 后台模式
if ($Detached) {
  $outLog = Join-Path $root 'server.log'
  $errLog = Join-Path $root 'server.err.log'
  $proc = Start-Process -FilePath 'node' -ArgumentList $nodeArgs -WorkingDirectory $root `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

  if (-not (Wait-Up -Seconds 15)) {
    Write-Host '[bomb] 启动失败, 日志如下:' -ForegroundColor Red
    if (Test-Path $outLog) { Get-Content $outLog -Tail 20 -Encoding UTF8 }
    if (Test-Path $errLog) { Get-Content $errLog -Tail 20 -Encoding UTF8 }
    exit 1
  }

  Write-Host ''
  Write-Host "[bomb] 服务已在后台运行 (进程号 $($proc.Id)), 端口 $Port ." -ForegroundColor Green
  Show-Addresses
  Write-Host "[bomb]   日志:     $outLog"
  Write-Host "[bomb]   停止:     .\stop.ps1 -Port $Port"
  Write-Host ''
  if (-not $NoBrowser) { Start-Process $url }
  exit 0
}

# ---------------------------------------------------------- 前台模式
$waiter = $null
if (-not $NoBrowser) {
  # 等端口真的起来再开浏览器, 免得开出一个错误页
  $waiter = Start-Job -ScriptBlock {
    param($p)
    for ($i = 0; $i -lt 60; $i++) {
      & node -e "fetch('http://127.0.0.1:' + process.argv[1] + '/api/rooms').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))" "$p" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { Start-Process "http://localhost:$p"; return }
      Start-Sleep -Milliseconds 250
    }
  } -ArgumentList $Port
}

Write-Host ''
Write-Host "[bomb] 正在启动服务, 端口 $Port ... (Ctrl+C 停止)" -ForegroundColor Cyan
Write-Host ''

try {
  & node @nodeArgs
} finally {
  if ($waiter) {
    Stop-Job $waiter -ErrorAction SilentlyContinue
    Remove-Job $waiter -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host '[bomb] 服务已经停止.'
