# Lecture -> Diagram: one-command startup.
# Run this from PowerShell: .\start.ps1
# Then open http://localhost:8010/static/index.html in Chrome.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment..."
    python -m venv .venv
}

Write-Host "Installing/checking dependencies..."
& ".\.venv\Scripts\python.exe" -m pip install -q -r requirements.txt

if (-not (Test-Path ".env")) {
    Write-Host "WARNING: .env not found. Copy .env.example to .env and add your GEMINI_API_KEY." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Starting server at http://localhost:8010/static/index.html" -ForegroundColor Green
Write-Host "(Ctrl+C to stop)"
Write-Host ""

& ".\.venv\Scripts\python.exe" -m uvicorn backend.main:app --port 8010
