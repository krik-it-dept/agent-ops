; Agent Ops NSIS hooks for electron-builder (nsis.include in electron-builder.yml).
;
; Every decision that touches processes, folders or the Go install is made by one
; fixed script, build/installer-helper.ps1, run with the fixed System32
; PowerShell and -File; paths are passed as separate argument values and never
; become PowerShell text. NSIS only branches on the helper's exit code.
;
; Install (per user, no administrator rights):
;   - the install folder must be %LOCALAPPDATA%\Programs\AgentOps: a /D= or a
;     recorded location elsewhere is refused, as is a link or junction in the
;     install folder or in any data path the installer writes or moves;
;   - an interrupted earlier bootstrap is finished first (bootstrap-recover);
;   - a Go install in that folder is moved as a recoverable transaction
;     (bootstrap-prepare: verified journal, exact-path stop, move whole to
;     %LOCALAPPDATA%\AgentOps\backups\go-install-<time>, verify). After the new
;     files are complete it is committed (bootstrap-commit, in customInstall); if
;     the installer stops before that, its next run puts the Go install back.
;     Nothing else of the Go version is retired here: its Apps & features entry,
;     startup and protocol entries and the old runtime folder are retired by the
;     app's first successful start (src/main/modules/updater/legacy-move.ts);
;   - the stock "app is running" check is replaced (customCheckAppRunning, also in
;     the uninstaller): only processes whose image is exactly this install's
;     agent-ops.exe are stopped, and a failure stops setup;
;   - registers the agent-ops: protocol and the notification AppUserModelID.
; Uninstall (not during an update):
;   - refuses an unexpected install folder or one with links inside;
;   - asks whether to remove skills (guarded --cleanup-skills) and whether to
;     delete the data folder (default: keep; never through a link);
;   - removes the startup entry, protocol, AppUserModelID key and the
;     AGENT_OPS_TASKS and AGENT_OPS_REPORT variables. The Tasks folder and its
;     plans are never touched.
;
; Nothing here runs while electron-builder builds the uninstaller on the build
; machine (BUILD_UNINSTALLER), so building never touches the registry.

!include LogicLib.nsh
!include FileFunc.nsh
!include WinMessages.nsh

!define AO_PROGRAMS_DIR "$LOCALAPPDATA\Programs\AgentOps"
!define AO_DATA_DIR "$LOCALAPPDATA\AgentOps"
!define AO_JOURNAL "${AO_DATA_DIR}\legacy-move\go-install-journal.txt"
!define AO_RECEIPT "${AO_DATA_DIR}\legacy-move\installer-receipt.txt"
!define AO_LOG "${AO_DATA_DIR}\logs\installer.log"
!define AO_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define AO_PROTOCOL_KEY "Software\Classes\agent-ops"
!define AO_AUMID_KEY "Software\Classes\AppUserModelId\KrikIT.AgentOps"
!define AO_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

Var aoCode
Var aoOut

; Puts the helper into the plugins folder (installer and uninstaller each embed it).
!macro aoExtractHelper
  InitPluginsDir
  ${IfNot} ${FileExists} "$PLUGINSDIR\installer-helper.ps1"
    File "/oname=$PLUGINSDIR\installer-helper.ps1" "${BUILD_RESOURCES_DIR}\installer-helper.ps1"
  ${EndIf}
!macroend

; Runs the helper with ARGS; exit code in $aoCode ("error" when it could not start), output in $aoOut.
!macro aoRunHelper ARGS
  nsExec::ExecToStack '"${AO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-helper.ps1" ${ARGS}'
  Pop $aoCode
  Pop $aoOut
!macroend

; Appends a line to the installer log. Used only after check-paths proved the
; log path has no link in it.
!macro aoLog TEXT
  Push $9
  CreateDirectory "${AO_DATA_DIR}\logs"
  ClearErrors
  FileOpen $9 "${AO_LOG}" a
  ${IfNot} ${Errors}
    FileSeek $9 0 END
    FileWrite $9 "${TEXT}$\r$\n"
    FileClose $9
  ${EndIf}
  Pop $9
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    ; A first install goes to Programs\AgentOps (electron-builder would use the
    ; package name). customInit refuses any other recorded or /D= location.
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 == ""
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "${AO_PROGRAMS_DIR}"
    ${EndIf}
  !endif
!macroend

; Replaces electron-builder's checker (installer and uninstaller): stop only this
; install's exact executable, by file identity, and stop setup if that fails.
!macro customCheckAppRunning
  !insertmacro aoExtractHelper
  !insertmacro aoRunHelper `stop -Executable "$INSTDIR\${APP_EXECUTABLE_FILENAME}"`
  ${If} $aoCode != "0"
    MessageBox MB_OK|MB_ICONSTOP "Agent Ops is running and could not be closed safely.$\r$\n$\r$\nClose Agent Ops (also in the notification area) and try again.$\r$\n$\r$\n$aoOut" /SD IDOK
    Quit
  ${EndIf}
!macroend

!macro customInit
  ; Never keep the working folder inside a folder that may move.
  SetOutPath $TEMP
  !insertmacro aoExtractHelper

  ; The supported install folder, and no link in any path this installer writes.
  !insertmacro aoRunHelper `check-paths -Expected "${AO_PROGRAMS_DIR}" -Actual "$INSTDIR" -Plain "${AO_LOG}|${AO_DATA_DIR}\backups|${AO_JOURNAL}|${AO_RECEIPT}"`
  ${If} $aoCode != "0"
    MessageBox MB_OK|MB_ICONSTOP "Agent Ops installs only for the current user into ${AO_PROGRAMS_DIR}, and none of its folders may be a link or junction. Nothing was changed.$\r$\n$\r$\n$aoOut" /SD IDOK
    Quit
  ${EndIf}

  ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
  StrCpy $8 "$3$2$1-$5$6$7"

  ; Finish an earlier run that stopped half-way (commit or put the Go install back).
  !insertmacro aoRunHelper `bootstrap-recover -Source "${AO_PROGRAMS_DIR}" -Journal "${AO_JOURNAL}" -Receipt "${AO_RECEIPT}"`
  !insertmacro aoLog "$8 bootstrap-recover exit $aoCode: $aoOut"
  ${If} $aoCode != "0"
    MessageBox MB_OK|MB_ICONSTOP "An earlier installation of Agent Ops did not finish and could not be completed or undone.$\r$\n$\r$\nThe earlier version is kept in ${AO_DATA_DIR}\backups. See ${AO_LOG}." /SD IDOK
    Quit
  ${EndIf}

  ; A Go self-install (v0.4.0) in the install folder: move it aside as a transaction.
  !insertmacro aoRunHelper `bootstrap-prepare -Source "${AO_PROGRAMS_DIR}" -BackupRoot "${AO_DATA_DIR}\backups" -Journal "${AO_JOURNAL}" -Stamp "$8"`
  !insertmacro aoLog "$8 bootstrap-prepare exit $aoCode: $aoOut"
  ${If} $aoCode != "0"
    MessageBox MB_OK|MB_ICONSTOP "Agent Ops could not move the earlier version out of ${AO_PROGRAMS_DIR}.$\r$\n$\r$\nClose Agent Ops (also in the notification area) and run this installer again. The earlier version still works.$\r$\n$\r$\n$aoOut" /SD IDOK
    Quit
  ${EndIf}
!macroend

!macro customInstall
  ; The new files are complete: commit a pending bootstrap (writes the receipt
  ; the first start reads). Without a pending bootstrap this does nothing.
  !insertmacro aoRunHelper `bootstrap-commit -Source "$INSTDIR" -Journal "${AO_JOURNAL}" -Receipt "${AO_RECEIPT}"`
  !insertmacro aoLog "bootstrap-commit exit $aoCode: $aoOut"
  ${If} $aoCode != "0"
    MessageBox MB_OK|MB_ICONSTOP "Agent Ops could not finish installing. Run the installer again; it puts the earlier version back if needed.$\r$\n$\r$\n$aoOut" /SD IDOK
    Quit
  ${EndIf}
  WriteRegStr HKCU "${AO_PROTOCOL_KEY}" "" "URL:Agent Ops"
  WriteRegStr HKCU "${AO_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${AO_PROTOCOL_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --activate "%1"'
  WriteRegStr HKCU "${AO_AUMID_KEY}" "DisplayName" "Agent Ops"
  WriteRegStr HKCU "${AO_AUMID_KEY}" "IconUri" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

!macro customUnInit
  ; The generated uninstaller deletes $INSTDIR recursively: only the supported
  ; folder, and never through a link inside it.
  !insertmacro aoExtractHelper
  !insertmacro aoRunHelper `check-paths -Expected "${AO_PROGRAMS_DIR}" -Actual "$INSTDIR" -Tree "$INSTDIR"`
  ${If} $aoCode != "0"
    MessageBox MB_OK|MB_ICONSTOP "Agent Ops can be uninstalled only from ${AO_PROGRAMS_DIR}, without links inside it. Nothing was removed.$\r$\n$\r$\n$aoOut" /SD IDOK
    Quit
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ; One-click switches to silent mode after its initial confirmation. Show
    ; these owner choices unless /S was explicitly requested by the caller.
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${If} ${Errors}
      SetSilent normal
    ${EndIf}
    ; electron-builder's one-click un.onInit calls un.checkAppRunning before
    ; entering the uninstall section and this hook. Keep the executable and
    ; data available until its guarded cleanup command has finished.
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove Agent Ops skills from your AI tools?$\r$\n$\r$\nChoose No to leave them installed (default). Modified files are kept." /SD IDNO IDNO aoKeepSkills
      ClearErrors
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --cleanup-skills' $R8
      ${If} ${Errors}
      ${OrIf} $R8 != "0"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Agent Ops could not finish removing skills. Modified files were kept.$\r$\n$\r$\nUninstall will continue. Review any remaining skills in your AI tools." /SD IDOK
      ${EndIf}
    aoKeepSkills:
    StrCpy $R9 "0"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Agent Ops settings and data?$\r$\n$\r$\n${AO_DATA_DIR}$\r$\n$\r$\nChoose No to keep them (recommended). Plans in your Tasks folder are never deleted." /SD IDNO IDNO aoKeepData
      StrCpy $R9 "1"
    aoKeepData:
    ${If} $R9 == "1"
      ; Never delete through a link: the data folder, its parents and everything inside.
      !insertmacro aoRunHelper `check-paths -Tree "${AO_DATA_DIR}"`
      ${If} $aoCode != "0"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Your settings and data were kept: ${AO_DATA_DIR} contains a link or junction.$\r$\n$\r$\n$aoOut" /SD IDOK
        StrCpy $R9 "0"
      ${EndIf}
    ${EndIf}
    SetSilent silent
    DeleteRegValue HKCU "${AO_RUN_KEY}" "Agent Ops"
    DeleteRegKey HKCU "${AO_PROTOCOL_KEY}"
    DeleteRegKey HKCU "${AO_AUMID_KEY}"
    DeleteRegValue HKCU "Environment" "AGENT_OPS_TASKS"
    DeleteRegValue HKCU "Environment" "AGENT_OPS_REPORT"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${If} $R9 == "1"
    ${AndIf} "$LOCALAPPDATA" != ""
      RMDir /r "${AO_DATA_DIR}"
    ${EndIf}
  ${EndIf}
!macroend
