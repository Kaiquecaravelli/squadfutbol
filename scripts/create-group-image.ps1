# create-group-image.ps1 — Gera imagem do grupo (ROBÔ + UEFA)
Add-Type -AssemblyName System.Drawing

$width  = 512
$height = 512
$output = Join-Path $PSScriptRoot "..\data\group-photo.png"

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# Fundo gradiente diagonal
$brush_bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($width, $height)),
  [System.Drawing.Color]::FromArgb(255, 5, 15, 55),
  [System.Drawing.Color]::FromArgb(255, 0, 0, 10)
)
$g.FillRectangle($brush_bg, 0, 0, $width, $height)

# Brilho circular azul no centro (simula glow)
for ($r = 200; $r -ge 10; $r -= 20) {
  $alpha = [int](30 * (1 - $r / 200))
  $c = [System.Drawing.Color]::FromArgb($alpha, 30, 100, 220)
  $br = New-Object System.Drawing.SolidBrush($c)
  $g.FillEllipse($br, (256 - $r), (210 - $r), $r * 2, $r * 2)
  $br.Dispose()
}

# Função estrela
function Draw-Star($cx, $cy, $r) {
  $pts = New-Object System.Collections.Generic.List[System.Drawing.PointF]
  for ($i = 0; $i -lt 10; $i++) {
    $angle = [Math]::PI * $i / 5 - [Math]::PI / 2
    $rad   = if ($i % 2 -eq 0) { $r } else { $r * 0.42 }
    $pts.Add((New-Object System.Drawing.PointF(
      [float]($cx + $rad * [Math]::Cos($angle)),
      [float]($cy + $rad * [Math]::Sin($angle))
    )))
  }
  $starBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 255, 215, 0))
  $g.FillPolygon($starBrush, $pts.ToArray())
  $starBrush.Dispose()
}

# 8 estrelas em arco (UEFA Champions style)
Draw-Star 256  50 15
Draw-Star 318  68 12
Draw-Star 194  68 12
Draw-Star 370 106 10
Draw-Star 142 106 10
Draw-Star 400 162  9
Draw-Star 112 162  9
Draw-Star 408 222  8

# Cores do robô
$blue1 = [System.Drawing.Color]::FromArgb(255, 25, 110, 210)
$blue2 = [System.Drawing.Color]::FromArgb(255, 10, 60, 140)
$cyan  = [System.Drawing.Color]::FromArgb(255, 0, 210, 255)
$pen   = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 80, 170, 255), 2)
$br1   = New-Object System.Drawing.SolidBrush($blue1)
$br2   = New-Object System.Drawing.SolidBrush($blue2)
$brCy  = New-Object System.Drawing.SolidBrush($cyan)

# Cabeça
$g.FillRectangle($br1, 196, 118, 120, 98)
$g.DrawRectangle($pen, 196, 118, 120, 98)

# Antena
$antPen = New-Object System.Drawing.Pen($cyan, 3)
$g.DrawLine($antPen, 256, 118, 256, 92)
$g.FillEllipse($br1, 246, 82, 20, 20)
$g.FillEllipse($brCy, 250, 86, 12, 12)

# Olhos
$g.FillEllipse($brCy, 216, 145, 26, 22)
$g.FillEllipse($brCy, 270, 145, 26, 22)
$brBlk = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
$g.FillEllipse($brBlk, 224, 151, 11, 11)
$g.FillEllipse($brBlk, 278, 151, 11, 11)
# Reflexo nos olhos
$brWht = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillEllipse($brWht, 226, 152, 5, 5)
$g.FillEllipse($brWht, 280, 152, 5, 5)

# Boca
$mPen = New-Object System.Drawing.Pen($cyan, 3)
$g.DrawArc($mPen, 222, 184, 68, 22, 0, 180)

# Pescoço
$g.FillRectangle($br2, 236, 216, 40, 16)
$g.DrawRectangle($pen, 236, 216, 40, 16)

# Corpo
$g.FillRectangle($br2, 174, 232, 164, 112)
$g.DrawRectangle($pen, 174, 232, 164, 112)

# Painel peito — bola de futebol
$brPanel = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 0, 150, 255))
$g.FillEllipse($brPanel, 214, 244, 84, 84)
$g.DrawEllipse($pen, 214, 244, 84, 84)
$lPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(140, 80, 180, 255), 1.5)
$g.DrawLine($lPen, 256, 244, 256, 328)
$g.DrawLine($lPen, 214, 286, 298, 286)
$g.DrawLine($lPen, 220, 254, 292, 318)
$g.DrawLine($lPen, 292, 254, 220, 318)

# Braços
$g.FillRectangle($br1, 134, 238, 38, 78)
$g.DrawRectangle($pen, 134, 238, 38, 78)
$g.FillRectangle($br1, 340, 238, 38, 78)
$g.DrawRectangle($pen, 340, 238, 38, 78)
# Mãos
$g.FillEllipse($br1, 130, 310, 46, 28)
$g.DrawEllipse($pen, 130, 310, 46, 28)
$g.FillEllipse($br1, 336, 310, 46, 28)
$g.DrawEllipse($pen, 336, 310, 46, 28)

# Pernas
$g.FillRectangle($br2, 194, 344, 54, 58)
$g.DrawRectangle($pen, 194, 344, 54, 58)
$g.FillRectangle($br2, 264, 344, 54, 58)
$g.DrawRectangle($pen, 264, 344, 54, 58)

# Pés
$g.FillRectangle($br1, 186, 398, 66, 18)
$g.DrawRectangle($pen, 186, 398, 66, 18)
$g.FillRectangle($br1, 260, 398, 66, 18)
$g.DrawRectangle($pen, 260, 398, 66, 18)

# Texto
$sfC = New-Object System.Drawing.StringFormat
$sfC.Alignment = [System.Drawing.StringAlignment]::Center

$fontBig = New-Object System.Drawing.Font("Arial Black", 26, [System.Drawing.FontStyle]::Bold)
$fontMid = New-Object System.Drawing.Font("Arial", 12, [System.Drawing.FontStyle]::Regular)
$fontSml = New-Object System.Drawing.Font("Arial", 10, [System.Drawing.FontStyle]::Italic)

$brGold  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 215, 0))
$brBlue  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 100, 180, 255))
$brWhite = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

$g.DrawString("SQUAD FUTBOL", $fontBig, $brGold,  256, 424, $sfC)
$g.DrawString("Betting Analysis  •  AI Powered", $fontMid, $brBlue, 256, 460, $sfC)
$g.DrawString("Analise Esportiva Profissional", $fontSml, $brWhite, 256, 482, $sfC)

# Borda
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 20, 90, 210), 5)
$g.DrawRectangle($borderPen, 4, 4, $width - 8, $height - 8)

$g.Dispose()
$bmp.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "OK: $output"
