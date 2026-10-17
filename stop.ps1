# ============================================================
#  保持沟通就没人爆炸 —— 停止脚本（Windows / PowerShell）
#
#    .\stop.ps1              停掉 3210 端口上的游戏服务
#    .\stop.ps1 -Port 8080   停掉别的端口
#
#  只会结束后台模式（.\start.ps1 -Detached）起的 node 进程；
#  前台模式直接在窗口里按 Ctrl+C 就行。
# ============================================================
[CmdletBinding()]
param([int]$Port = 3210)

$lines = netstat -ano | Select-String ":$Port .*LISTENING"
$pids = @($lines | ForEach-Object { ($_ -split '\s+')[-1] } | Where-Object { $_ -match '^\d+$' } | Sort-Object -Unique)

if ($pids.Count -eq 0) {
  Write-Host "[bomb] 端口 $Port 上没有在跑的服务。" -ForegroundColor Yellow
  exit 0
}

$stopped = 0
foreach ($p in $pids) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  if ($proc.ProcessName -notlike 'node*') {
    Write-Host "[bomb] 端口 $Port 被 $($proc.ProcessName)（进程号 $p）占用，看起来不是本游戏，跳过。" -ForegroundColor Yellow
    continue
  }
  Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  Write-Host "[bomb] 已停止 node 进程 $p" -ForegroundColor Green
  $stopped++
}

if ($stopped -eq 0) { Write-Host "[bomb] 没有停掉任何进程。" -ForegroundColor Yellow }
