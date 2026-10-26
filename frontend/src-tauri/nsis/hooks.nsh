!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$EXEDIR\_internal\*.*"
    DetailPrint "Copying optional offline AI runtime (_internal)..."
    CreateDirectory "$INSTDIR\_internal"
    CopyFiles /SILENT "$EXEDIR\_internal\*.*" "$INSTDIR\_internal"
  ${EndIf}

  ${If} ${FileExists} "$EXEDIR\checkpoints\*.*"
    DetailPrint "Copying optional bundled AI checkpoints..."
    CreateDirectory "$INSTDIR\checkpoints"
    CopyFiles /SILENT "$EXEDIR\checkpoints\*.*" "$INSTDIR\checkpoints"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\_internal\*.*"
    DetailPrint "Removing RotoFox AI runtime (_internal)..."
    RMDir /r "$INSTDIR\_internal"
  ${EndIf}
!macroend
