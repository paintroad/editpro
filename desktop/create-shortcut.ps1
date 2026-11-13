# Creates the EditPro shortcut on the desktop and in the Start menu, pointing at the desktop app.
$ErrorActionPreference = "Stop"
$desktopApp = $PSScriptRoot
$electron = Join-Path $desktopApp "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "Run npm install in $desktopApp first" }
$icon = Join-Path $desktopApp "editpro.ico"
if (-not (Test-Path $icon)) { throw "Run npm run icon in $desktopApp first" }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "EditPro.lnk"))
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$desktopApp`""
  $lnk.WorkingDirectory = $desktopApp
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = "EditPro"
  $lnk.Save()
  Write-Output "Shortcut: $(Join-Path $dir 'EditPro.lnk')"
}
