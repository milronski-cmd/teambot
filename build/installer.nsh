; TeamBot installer additions. electron-builder puts this file in the script header of both the installer and the
; uninstaller (package.json build.nsis.include). Checked by tests/installer-nsh.test.ts; it never runs on a dev pc.
;
; The installer is one-click and per user (package.json build.nsis, tests/installer-config.test.ts): no questions and
; no admin prompt; it installs in %LOCALAPPDATA%\Programs\TeamBot (or where TeamBot already is), makes the Start menu
; and desktop shortcut and starts TeamBot. /S installs silently (updates, the owner's scripts), /D=<folder> picks
; another folder. /currentuser is accepted and changes nothing.
;
; A running TeamBot (0.4.4, found installing 0.4.3 over a running 0.4.2: exit code 2, TeamBot gone, files still old):
; - customCheckAppRunning (installer and uninstaller): build/teambot-close.ps1 asks TeamBot to quit ("TeamBot.exe
;   --quit", desktop/main.ts), waits, then ends only TeamBot's own processes, found by the install folder, and the
;   helpers they started (one of those kept a file of the install folder in use, so the old uninstaller failed).
;   Never by program name, never this installer. Also in silent mode; the install then continues.
; - customUnInstallCheck: the old version's uninstaller still failed: close again and try once more; if it still
;   fails, start the old TeamBot again before stopping (the owner is never left without TeamBot).
; - customInstall: TeamBot always starts after installing, also silently. electron-builder itself only starts it
;   when not silent or with --force-run (an automatic update passes that), so here only for silent without it.
;
; Uninstall (D-02): ask whether the data goes too. Everything TeamBot keeps is in %APPDATA%\TeamBot: bots, chats,
; memory, routines, encrypted keys, backups and the Electron profile (server/core/config.ts, desktop/main.ts).
; - A one-click uninstaller asks "Weet je zeker dat je TeamBot wilt verwijderen?" in un.onInit, closes a running
;   TeamBot and then makes itself silent (SetSilent silent) before the uninstall section runs. A question in that
;   section would answer itself, so it is asked here in un.onInit (customUnInit, right after that confirmation) and
;   the section only carries out the answer (customUnInstall).
; - Only when a person started the uninstaller (Settings › Apps, the Start menu): never with /S on the command line
;   (QuietUninstallString, scripts), never during an update (the installer of a new version, electron-updater and
;   "Terug naar versie x" run the old uninstaller with /S --updated), never with --delete-app-data (electron-builder's
;   own meaning: delete without asking; electron-builder does that itself after this macro).
; - No is the default button: Enter keeps the data, so a reinstall picks everything up again. Only Yes deletes.
; - Electron data is always per user, also when an older TeamBot was installed for all users: like electron-builder's
;   own --delete-app-data code we switch to the user's folders and back, because the rest of the uninstaller
;   (registry, start menu) works in the context of the installation.
;
; The texts are NSIS language strings. makensis stops (warning 6040, electron-builder builds with -WX) unless a
; LangString exists for exactly the languages the installer loads: electron-builder's 26 bundled languages, because
; nsis.installerLanguages is not set (NSIS picks the one of Windows). Dutch gets the Dutch text, the others English.

!define TEAMBOT_DATA_DIR "$APPDATA\TeamBot"

LangString teambotDeleteData 1043 "Ook je gegevens verwijderen (bots, gesprekken, geheugen)?$\r$\n$\r$\nDat is alles in ${TEAMBOT_DATA_DIR}, ook je routines, sleutels en back-ups. Dit kun je niet ongedaan maken.$\r$\n$\r$\nKies Nee om ze te bewaren: na opnieuw installeren is alles er weer."
LangString teambotDeleteDataFailed 1043 "Niet al je TeamBot-gegevens konden worden verwijderd. Wat over is, staat in:$\r$\n${TEAMBOT_DATA_DIR}$\r$\n$\r$\nJe kunt die map zelf verwijderen."

!define TEAMBOT_EN_DELETE_DATA "Also delete your data (bots, chats, memory)?$\r$\n$\r$\nThat is everything in ${TEAMBOT_DATA_DIR}, including your routines, keys and backups. This cannot be undone.$\r$\n$\r$\nChoose No to keep it: after reinstalling, everything is back."
!define TEAMBOT_EN_DELETE_DATA_FAILED "Not all of your TeamBot data could be deleted. What is left is in:$\r$\n${TEAMBOT_DATA_DIR}$\r$\n$\r$\nYou can delete that folder yourself."

!macro teambotEnglishTexts LANG_ID
  LangString teambotDeleteData ${LANG_ID} "${TEAMBOT_EN_DELETE_DATA}"
  LangString teambotDeleteDataFailed ${LANG_ID} "${TEAMBOT_EN_DELETE_DATA_FAILED}"
!macroend

; en_US de_DE fr_FR es_ES zh_CN zh_TW ja_JP ko_KR it_IT da_DK sv_SE nb_NO fi_FI ru_RU pt_PT pt_BR pl_PL uk_UA cs_CZ
; sk_SK hu_HU ar_SA tr_TR th_TH vi_VN (nl_NL = 1043 above)
!insertmacro teambotEnglishTexts 1033
!insertmacro teambotEnglishTexts 1031
!insertmacro teambotEnglishTexts 1036
!insertmacro teambotEnglishTexts 3082
!insertmacro teambotEnglishTexts 2052
!insertmacro teambotEnglishTexts 1028
!insertmacro teambotEnglishTexts 1041
!insertmacro teambotEnglishTexts 1042
!insertmacro teambotEnglishTexts 1040
!insertmacro teambotEnglishTexts 1030
!insertmacro teambotEnglishTexts 1053
!insertmacro teambotEnglishTexts 1044
!insertmacro teambotEnglishTexts 1035
!insertmacro teambotEnglishTexts 1049
!insertmacro teambotEnglishTexts 2070
!insertmacro teambotEnglishTexts 1046
!insertmacro teambotEnglishTexts 1045
!insertmacro teambotEnglishTexts 1058
!insertmacro teambotEnglishTexts 1029
!insertmacro teambotEnglishTexts 1051
!insertmacro teambotEnglishTexts 1038
!insertmacro teambotEnglishTexts 1025
!insertmacro teambotEnglishTexts 1055
!insertmacro teambotEnglishTexts 1054
!insertmacro teambotEnglishTexts 1066

; Only in the uninstaller: in the installer build the variable would never be used (warning 6001 stops makensis).
!ifdef BUILD_UNINSTALLER
  ; "1" after the person chose Yes in customUnInit; customUnInstall then deletes the data folder.
  Var teambotRemoveData
!endif

; un.onInit, after electron-builder's own confirmation and the check that TeamBot is closed.
!macro customUnInit
  StrCpy $teambotRemoveData "0"
  Push $R0
  Push $R1
  ${GetParameters} $R0
  ClearErrors
  ; The same test electron-builder's un.onInit uses: no /S on the command line = a person started the uninstaller.
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
  ${AndIfNot} ${isUpdated}
  ${AndIfNot} ${isDeleteAppData}
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    ${If} ${FileExists} "${TEAMBOT_DATA_DIR}\*.*"
      ; The one-click uninstaller is silent by now; for this one question it is not.
      !ifdef ONE_CLICK
        SetSilent normal
      !endif
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(teambotDeleteData)" /SD IDNO IDYES`
        StrCpy $teambotRemoveData "1"
      ${EndIf}
      !ifdef ONE_CLICK
        SetSilent silent
      !endif
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

; The watchdog outside the app (0.4.4, P14; build/watchdog.ps1, shipped in resources): a scheduled task of this user that
; checks every 10 minutes whether TeamBot runs and answers. A task of the user himself: no /RU, no /RL HIGHEST, in the
; root folder (making a task folder can need admin rights), so no admin rights and no UAC prompt. The name carries the
; Windows account, because task names are shared by everyone on the pc. conhost --headless keeps the console out of
; sight. /F replaces the task of an older version.

; Before the installer closes a running TeamBot (an update, a reinstall, Terug naar versie): "bewust gestopt" for the
; watchdog, so being closed, or stopped hard, by the installer is never reported as a crash. Only when TeamBot's data
; folder exists (a fresh install has nothing running and nothing to watch). The next start of TeamBot removes it.
!macro customInit
  ${If} ${FileExists} "${TEAMBOT_DATA_DIR}\*.*"
    Push $R7
    CreateDirectory "${TEAMBOT_DATA_DIR}\health"
    ClearErrors
    FileOpen $R7 "${TEAMBOT_DATA_DIR}\health\stopped.json" w
    ${IfNot} ${Errors}
      FileWrite $R7 '{"reason":"installer"}'
      FileClose $R7
    ${EndIf}
    Pop $R7
  ${EndIf}
!macroend

; The uninstall section (silent in a one-click uninstaller), before the program files are removed.
!macro customUnInstall
  ; The watchdog task goes with the program, but not during an update (the new installer makes it again).
  ${IfNot} ${isUpdated}
    Push $R7
    Push $R8
    Push $R9
    ReadEnvStr $R8 USERDOMAIN
    ReadEnvStr $R9 USERNAME
    nsExec::Exec 'schtasks.exe /Delete /F /TN "TeamBot Wachter ($R8 $R9)"'
    Pop $R7
    Pop $R9
    Pop $R8
    Pop $R7
  ${EndIf}
  ${If} $teambotRemoveData == "1"
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    DetailPrint "TeamBot: deleting ${TEAMBOT_DATA_DIR}"
    RMDir /r "${TEAMBOT_DATA_DIR}"
    ${If} ${FileExists} "${TEAMBOT_DATA_DIR}\*.*"
      ; No /SD: this only runs after a person chose Yes, and the section is silent, so it must still show.
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(teambotDeleteDataFailed)"
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${Else}
    DetailPrint "TeamBot: data kept in ${TEAMBOT_DATA_DIR}"
  ${EndIf}
!macroend

; ---------------------------------------------------------------- a running TeamBot, and starting it afterwards

; Instead of electron-builder's check (it ended TeamBot.exe but not the helpers it started; in silent mode the old
; uninstaller then failed and the installer quit with code 2). Runs in the installer (install section) and in the
; uninstaller (un.onInit). Only processes in $INSTDIR and what they started; never by program name.
!macro customCheckAppRunning
  InitPluginsDir
  File "/oname=$PLUGINSDIR\teambot-close.ps1" "${BUILD_RESOURCES_DIR}\teambot-close.ps1"
  System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMBOT_INSTDIR", t "$INSTDIR")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMBOT_EXE", t "${APP_EXECUTABLE_FILENAME}")i'
  DetailPrint "TeamBot: closing a running TeamBot"
  nsExec::ExecToLog `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\teambot-close.ps1"`
  Pop $R9
  ${If} $R9 != 0
    ; Something came back or held on: once more, without asking again.
    Sleep 2000
    System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMBOT_CLOSE_WAIT_MS", t "0")i'
    nsExec::ExecToLog `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\teambot-close.ps1"`
    Pop $R9
    System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMBOT_CLOSE_WAIT_MS", n)i'
  ${EndIf}
  ; electron-builder sets these for its own check; not needed here.
  StrCpy $CmdPath ""
!macroend

!ifndef BUILD_UNINSTALLER
  ; After the old version's uninstaller ran ($R0 = its exit code). electron-builder would stop here with code 2 and
  ; leave the owner without TeamBot (the old files stay, nothing runs).
  !macro customUnInstallCheck
    ${If} ${Errors}
    ${OrIf} $R0 != 0
      DetailPrint "TeamBot: the old version could not be removed ($R0); closing TeamBot again and trying once more"
      ClearErrors
      System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMBOT_CLOSE_WAIT_MS", t "0")i'
      ; $PowerShellPath is declared later in the script than this function: the system path itself.
      nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\teambot-close.ps1"`
      Pop $R9
      Sleep 1000
      Push SHELL_CONTEXT
      Call uninstallOldVersion
      ${If} ${Errors}
      ${OrIf} $R0 != 0
        DetailPrint "TeamBot: the old version could not be removed ($R0); starting it again"
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
        ${If} ${FileExists} "$appExe"
          ${StdUtils.ExecShellAsUser} $R9 "$appExe" "open" ""
        ${EndIf}
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !macroend

!endif

; The install step (after the section about a running TeamBot: the watchdog task, then always start TeamBot).
!macro customInstall
  Push $R7
  Push $R8
  Push $R9
  ReadEnvStr $R8 USERDOMAIN
  ReadEnvStr $R9 USERNAME
  nsExec::Exec 'schtasks.exe /Create /F /SC MINUTE /MO 10 /TN "TeamBot Wachter ($R8 $R9)" /TR "conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"$INSTDIR\resources\watchdog.ps1\""'
  Pop $R7
  Pop $R9
  Pop $R8
  Pop $R7
  ; Then start TeamBot (end of the install section, right before electron-builder's own start, which only runs when not
  ; silent or with --force-run).
  !ifndef BUILD_UNINSTALLER
  ${If} ${Silent}
  ${AndIfNot} ${isForceRun}
    HideWindow
    ${If} ${isUpdated}
      ${StdUtils.ExecShellAsUser} $R9 "$launchLink" "open" "--updated"
    ${Else}
      ${StdUtils.ExecShellAsUser} $R9 "$launchLink" "open" ""
    ${EndIf}
    DetailPrint "TeamBot: started ($R9)"
  ${EndIf}
  !endif
!macroend
