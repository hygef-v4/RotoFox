!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$EXEDIR\_internal\*.*"
    DetailPrint "Copying RotoFox AI runtime (_internal)..."
    CreateDirectory "$INSTDIR\_internal"
    CopyFiles /SILENT "$EXEDIR\_internal\*.*" "$INSTDIR\_internal"
  ${ElseIf} ${FileExists} "$EXEDIR\rotofox-backend\_internal\*.*"
    DetailPrint "Copying RotoFox AI runtime (_internal)..."
    CreateDirectory "$INSTDIR\_internal"
    CopyFiles /SILENT "$EXEDIR\rotofox-backend\_internal\*.*" "$INSTDIR\_internal"
  ${ElseIf} ${FileExists} "$EXEDIR\..\..\..\..\binaries\rotofox-backend\_internal\*.*"
    DetailPrint "Copying RotoFox AI runtime (_internal) from build tree..."
    CreateDirectory "$INSTDIR\_internal"
    CopyFiles /SILENT "$EXEDIR\..\..\..\..\binaries\rotofox-backend\_internal\*.*" "$INSTDIR\_internal"
  ${ElseIf} ${FileExists} "$EXEDIR\..\..\..\..\..\backend\dist\rotofox-backend\_internal\*.*"
    DetailPrint "Copying RotoFox AI runtime (_internal) from backend dist..."
    CreateDirectory "$INSTDIR\_internal"
    CopyFiles /SILENT "$EXEDIR\..\..\..\..\..\backend\dist\rotofox-backend\_internal\*.*" "$INSTDIR\_internal"
  ${EndIf}

  ${If} ${FileExists} "$EXEDIR\checkpoints\*.*"
    DetailPrint "Copying bundled AI checkpoints..."
    CreateDirectory "$INSTDIR\checkpoints"
    CopyFiles /SILENT "$EXEDIR\checkpoints\*.*" "$INSTDIR\checkpoints"
  ${ElseIf} ${FileExists} "$EXEDIR\..\..\..\..\..\backend\checkpoints\*.*"
    DetailPrint "Copying AI checkpoints from backend..."
    CreateDirectory "$INSTDIR\checkpoints"
    CopyFiles /SILENT "$EXEDIR\..\..\..\..\..\backend\checkpoints\*.*" "$INSTDIR\checkpoints"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\_internal\*.*"
    DetailPrint "Removing RotoFox AI runtime (_internal)..."
    RMDir /r "$INSTDIR\_internal"
  ${EndIf}
!macroend
