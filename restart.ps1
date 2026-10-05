$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
Set-Location -LiteralPath "C:\Users\homek\Downloads\OpenWA"
npm run dev > output.log 2>&1