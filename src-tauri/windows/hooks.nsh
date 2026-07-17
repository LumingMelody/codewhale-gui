!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM codewhale.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM codewhale-tui.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM codewhale.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM codewhale-tui.exe'
  Pop $0
  Sleep 500
!macroend
