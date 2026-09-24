; JARVIS Windows installer (NSIS 3, Modern UI 2)
; Built by scripts/build/package-windows.mjs:
;   makensis -DVERSION=x.y.z -DSTAGE=<dir> -DOUTFILE=<exe> -DICON=<ico> -DBUILDKIND=release installer.nsi
;
; Per-user install (no administrator rights needed). User data in
; %APPDATA%\JARVIS (settings, encrypted secrets, memory, audit log) is preserved
; on update and, unless the user opts in, on uninstall.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef VERSION
  !error "VERSION not defined"
!endif

!define APPNAME "JARVIS"
!define PUBLISHER "JARVIS"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
!define WEBVIEW2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WEBVIEW2_URL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
BrandingText "${APPNAME} ${VERSION} (${BUILDKIND})"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APPNAME} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) ${PUBLISHER}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\JARVIS.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch JARVIS"

Var CreateDesktopShortcut
Var RemoveUserData

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
Page custom OptionsPage OptionsLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataPage un.DataLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

!include "nsDialogs.nsh"
Var Chk

Function OptionsPage
  !insertmacro MUI_HEADER_TEXT "Options" "Choose additional shortcuts."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateCheckbox} 0 0 100% 12u "Create a desktop shortcut"
  Pop $Chk
  ${NSD_Check} $Chk
  nsDialogs::Show
FunctionEnd

Function OptionsLeave
  ${NSD_GetState} $Chk $CreateDesktopShortcut
FunctionEnd

Function un.DataPage
  !insertmacro MUI_HEADER_TEXT "Your data" "JARVIS keeps your settings, memory and audit log in %APPDATA%\JARVIS."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Your files are never touched. Optionally remove JARVIS's own data (settings, encrypted keys, memory, logs). Leave unchecked to keep it for a future reinstall."
  Pop $0
  ${NSD_CreateCheckbox} 0 30u 100% 12u "Also remove JARVIS data from this computer"
  Pop $Chk
  nsDialogs::Show
FunctionEnd

Function un.DataLeave
  ${NSD_GetState} $Chk $RemoveUserData
FunctionEnd

Function .onInit
  ; Windows 10 1809+ (build 17763) or Windows 11, 64-bit only.
  ${If} ${RunningX64}
  ${Else}
    MessageBox MB_ICONSTOP "JARVIS requires 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
FunctionEnd

Function CheckWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "JARVIS needs the Microsoft Edge WebView2 Runtime, which is not installed.$\r$\n$\r$\nOpen the official Microsoft download page now? (Install it, then start JARVIS.)" IDNO +2
    ExecShell "open" "${WEBVIEW2_URL}"
    DetailPrint "WebView2 Runtime missing - user directed to Microsoft download."
  ${Else}
    DetailPrint "WebView2 Runtime $0 found."
  ${EndIf}
FunctionEnd

Section "JARVIS" SecMain
  SectionIn RO
  ; Stop running instances so files can be replaced during updates.
  nsExec::Exec 'taskkill /F /IM JARVIS.exe /T'
  nsExec::Exec 'taskkill /F /IM jarvis-core.exe /T'
  Sleep 500

  SetOutPath "$INSTDIR"
  ClearErrors
  File "${STAGE}\JARVIS.exe"
  File "${STAGE}\jarvis-core.exe"
  File /nonfatal "${STAGE}\WebView2Loader.dll"
  File "${STAGE}\LICENSE.txt"
  File "${STAGE}\USER_MANUAL.md"
  RMDir /r "$INSTDIR\core-modules"
  SetOutPath "$INSTDIR\core-modules"
  File /r "${STAGE}\core-modules\*.*"
  SetOutPath "$INSTDIR"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Installation failed: some files could not be written to $INSTDIR. Close JARVIS and try again, or choose another folder."
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\JARVIS.exe"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"
  ${If} $CreateDesktopShortcut == ${BST_CHECKED}
    CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\JARVIS.exe"
  ${EndIf}

  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APPNAME}" "Version" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\JARVIS.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"

  Call CheckWebView2
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM JARVIS.exe /T'
  nsExec::Exec 'taskkill /F /IM jarvis-core.exe /T'
  Sleep 500
  Delete "$INSTDIR\JARVIS.exe"
  Delete "$INSTDIR\jarvis-core.exe"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\USER_MANUAL.md"
  RMDir /r "$INSTDIR\core-modules"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "Software\${APPNAME}"
  ${If} $RemoveUserData == ${BST_CHECKED}
    RMDir /r "$APPDATA\${APPNAME}"
    ; The secrets master key lives in Windows Credential Manager.
    nsExec::Exec 'cmdkey /delete:secrets-master-key.JARVIS'
  ${EndIf}
SectionEnd
