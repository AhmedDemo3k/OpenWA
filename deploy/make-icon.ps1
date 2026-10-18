#requires -Version 5.1
<#
Builds deploy\openwa.ico from the repository logo so the Start/Stop shortcuts have a real
icon instead of the PowerShell default.

Why a hand-rolled writer rather than [System.Drawing.Icon]::FromHandle: GDI+ builds that
icon through a color-keyed mask and drops the alpha channel, so the logo comes out with a
jagged black fringe at every size. Writing the DIB frames directly keeps 32-bit alpha.

The output is a multi-resolution ICO (16/24/32/48/64/128/256) because Windows picks a
different frame per context: 16px in the taskbar, 32px in Explorer, 256px on the desktop.
A single large frame would be downsampled by Explorer and look soft.
#>

[CmdletBinding()]
param(
    # Source artwork. Defaults to the repository logo.
    [string] $Source,

    [string] $Output,

    [int[]] $Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# $PSScriptRoot is not populated while parameter defaults are being bound under Windows
# PowerShell 5.1, so the paths are resolved in the body instead of in param().
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) { $Source = Join-Path (Split-Path $scriptDir -Parent) 'docs\logo\openwa_logo.png' }
if (-not $Output) { $Output = Join-Path $scriptDir 'openwa.ico' }

if (-not (Test-Path -LiteralPath $Source)) { throw "source image not found: $Source" }

# Returns the 32bpp BGRA DIB bytes (header + XOR + AND mask) for one icon frame, scaled to
# fit $Size x $Size with the aspect ratio preserved and the image centred.
function New-IconFrame([System.Drawing.Image] $Image, [int] $Size) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)

        $scale = [Math]::Min($Size / $Image.Width, $Size / $Image.Height)
        $w = [int][Math]::Round($Image.Width * $scale)
        $h = [int][Math]::Round($Image.Height * $scale)
        $x = [int](($Size - $w) / 2)
        $y = [int](($Size - $h) / 2)
        $g.DrawImage($Image, $x, $y, $w, $h)
    } finally {
        $g.Dispose()
    }

    $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $pixels = New-Object byte[] ($stride * $Size)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    } finally {
        $bmp.UnlockBits($data)
        $bmp.Dispose()
    }

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    try {
        # BITMAPINFOHEADER. biHeight is doubled because it counts the colour image and the
        # following 1bpp AND mask as one bitmap.
        $bw.Write([int] 40)
        $bw.Write([int] $Size)
        $bw.Write([int] ($Size * 2))
        $bw.Write([int16] 1)
        $bw.Write([int16] 32)
        $bw.Write([int] 0)
        $bw.Write([int] 0)
        $bw.Write([int] 0)
        $bw.Write([int] 0)
        $bw.Write([int] 0)
        $bw.Write([int] 0)

        # XOR image, bottom-up.
        for ($row = $Size - 1; $row -ge 0; $row--) {
            $bw.Write($pixels, $row * $stride, $Size * 4)
        }

        # AND mask: one bit per pixel, rows padded to a 4-byte boundary. With 32-bit alpha
        # present the mask is unused, so an all-zero mask is correct.
        $maskStride = [int]([Math]::Floor(($Size + 31) / 32) * 4)
        $bw.Write((New-Object byte[] ($maskStride * $Size)), 0, $maskStride * $Size)
        $bw.Flush()
        return $ms.ToArray()
    } finally {
        $bw.Dispose()
        $ms.Dispose()
    }
}

$image = [System.Drawing.Image]::FromFile($Source)
try {
    $frames = @()
    foreach ($size in $Sizes) {
        $frames += [pscustomobject]@{ Size = $size; Data = (New-IconFrame $image $size) }
    }
} finally {
    $image.Dispose()
}

# ICONDIR + one ICONDIRENTRY per frame + the frame payloads.
$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($out)
try {
    $writer.Write([int16] 0)             # reserved
    $writer.Write([int16] 1)             # type: icon
    $writer.Write([int16] $frames.Count)

    $offset = 6 + (16 * $frames.Count)
    foreach ($f in $frames) {
        $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }   # 0 means 256
        $writer.Write([byte] $dim)
        $writer.Write([byte] $dim)
        $writer.Write([byte] 0)          # palette colour count
        $writer.Write([byte] 0)          # reserved
        $writer.Write([int16] 1)         # colour planes
        $writer.Write([int16] 32)        # bits per pixel
        $writer.Write([int] $f.Data.Length)
        $writer.Write([int] $offset)
        $offset += $f.Data.Length
    }

    foreach ($f in $frames) { $writer.Write($f.Data, 0, $f.Data.Length) }
    $writer.Flush()

    [System.IO.File]::WriteAllBytes($Output, $out.ToArray())
} finally {
    $writer.Dispose()
    $out.Dispose()
}

Write-Host "wrote $Output ($($Sizes -join ', ') px, $([Math]::Round((Get-Item -LiteralPath $Output).Length / 1KB, 1)) KB)"
