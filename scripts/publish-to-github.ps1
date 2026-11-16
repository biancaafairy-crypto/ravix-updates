param(
    [Parameter(Mandatory=$false)]
    [string]$Token = $env:GITHUB_TOKEN,

    [Parameter(Mandatory=$false)]
    [string]$Version = "0.3.5",

    [Parameter(Mandatory=$false)]
    [string]$Repo = "ivyfated/ravix-updates"
)

if (-not $Token) {
    Write-Host "ERRO: Token do GitHub não fornecido." -ForegroundColor Red
    Write-Host "Uso: .\scripts\publish-to-github.ps1 -Token 'ghp_xxx' [-Version '0.2.3']" -ForegroundColor Yellow
    Write-Host "Ou defina a variável de ambiente `$env:GITHUB_TOKEN = 'ghp_xxx'`" -ForegroundColor Yellow
    exit 1
}

$releaseDir = "release-dist\v$Version"
if (-not (Test-Path $releaseDir)) {
    Write-Host "ERRO: Diretório '$releaseDir' não encontrado." -ForegroundColor Red
    exit 1
}

$installer = Join-Path $releaseDir "RAVIX_${Version}_x64-setup.exe"
$signature = Join-Path $releaseDir "RAVIX_${Version}_x64-setup.exe.sig"
$manifest = Join-Path $releaseDir "latest.json"

if (-not (Test-Path $installer) -or -not (Test-Path $signature) -or -not (Test-Path $manifest)) {
    Write-Host "ERRO: Artefatos incompletos em $releaseDir." -ForegroundColor Red
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $Token"
    "Accept"        = "application/vnd.github+json"
    "User-Agent"    = "RAVIX-Release-Uploader"
}

Write-Host "==> Verificando repositório $Repo no GitHub..." -ForegroundColor Cyan
try {
    $repoInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo" -Headers $headers -Method Get
    Write-Host "OK: Conectado ao repositório $($repoInfo.full_name)" -ForegroundColor Green
} catch {
    Write-Host "ERRO ao acessar repositório: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$tagName = "v$Version"
$releaseTitle = "RAVIX V$Version"
$releaseBody = "Correção da identificação de versão e melhorias de confiabilidade do atualizador integrado."

Write-Host "==> Criando Release $releaseTitle ($tagName)..." -ForegroundColor Cyan
$releasePayload = @{
    tag_name         = $tagName
    target_commitish = "main"
    name             = $releaseTitle
    body             = $releaseBody
    draft            = $false
    prerelease       = $false
} | ConvertTo-Json

try {
    $newRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Method Post -Body $releasePayload
    Write-Host "OK: Release criado com ID $($newRelease.id)" -ForegroundColor Green
} catch {
    Write-Host "Aviso: Release pode já existir, buscando..." -ForegroundColor Yellow
    $newRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$tagName" -Headers $headers -Method Get
    Write-Host "OK: Release encontrado com ID $($newRelease.id)" -ForegroundColor Green
}

$uploadUrlBase = $newRelease.upload_url.Replace("{?name,label}", "")

function Upload-Asset([string]$filePath, [string]$contentType) {
    $fileName = [System.IO.Path]::GetFileName($filePath)
    $uploadUri = "$uploadUrlBase`?name=$fileName"
    Write-Host "==> Enviando $fileName..." -ForegroundColor Cyan

    $uploadHeaders = @{
        "Authorization" = "Bearer $Token"
        "Content-Type"  = $contentType
        "User-Agent"    = "RAVIX-Release-Uploader"
    }

    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $filePath))
    $resp = Invoke-RestMethod -Uri $uploadUri -Headers $uploadHeaders -Method Post -Body $bytes
    Write-Host "OK: $fileName enviado com sucesso!" -ForegroundColor Green
}

Upload-Asset $installer "application/octet-stream"
Upload-Asset $signature "text/plain"
Upload-Asset $manifest "application/json"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " PUBLICAÇÃO CONCLUÍDA COM SUCESSO NO GITHUB RELEASES!    " -ForegroundColor Green
Write-Host " URL do Release: $($newRelease.html_url)                  " -ForegroundColor Green
Write-Host " Endpoint do Updater:                                     " -ForegroundColor Green
Write-Host " https://github.com/$Repo/releases/latest/download/latest.json " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green
