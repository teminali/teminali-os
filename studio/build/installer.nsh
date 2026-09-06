; Teminali OS — the Windows installer's own pages.
;
; electron-builder's assisted installer has no welcome page unless one is
; defined here, and its finish page is generic. These two macros are picked up
; by app-builder-lib/templates/nsis/assistedInstaller.nsh (`!ifmacrodef
; customWelcomePage` / `customFinishPage`); the sidebar and header bitmaps
; beside this file are wired from electron-builder.yml. The finish page keeps
; electron-builder's own StartApp function verbatim, because defining a custom
; finish page replaces it — and it is the function that passes `--updated` to a
; build the installer has just replaced.
;
; Regenerate the bitmaps with scripts/installer-art.sh. See studio/README.md →
; Packaging → The installer wizard.

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Teminali OS"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "Teminali OS is an autonomous AI studio: plan, edit, run and verify software, then record, cut and ship the video that shows it.$\r$\n$\r$\nThis wizard installs Teminali OS for the current user and adds a shortcut to the Start menu and the desktop. No administrator password is needed.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_FINISHPAGE_RUN_TEXT "Open Teminali OS now"
  !endif
  !define MUI_FINISHPAGE_TITLE "Teminali OS is installed"
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TEXT "Open it from the desktop or the Start menu.$\r$\n$\r$\nUpdates are checked from inside the app and installed from the version control in its corner; you will not need this wizard again.$\r$\n$\r$\nThe agents it drives — Claude Code, Codex — are found on your PATH, or in npm's and their own installers' folders."
  !insertmacro MUI_PAGE_FINISH
!macroend
